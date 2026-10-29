// Dashboard: polls /api/state and streams /api/events. No build step.
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const short = (h, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : '—')

const FACES = { happy: '😺', content: '🐱', hungry: '😿', alarmed: '🙀', asleep: '😴' }

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? res.statusText)
  return json
}

function renderPet(s) {
  const { pet, soul } = s
  $('pet-face').textContent = FACES[pet.mood] ?? '🐱'
  $('pet-name').textContent = pet.name
  $('pet-status').textContent = `${pet.status} · ${pet.mood}`
  $('pet-energy').style.width = `${pet.energy}%`
  $('pet-energy-num').textContent = `${pet.energy}/100`
  $('pet-balance').textContent = `${pet.balance.toLocaleString()} sats`
  $('soul-txid').textContent = soul ? short(soul.txid, 16) : '—'
  $('soul-txid').title = soul?.txid ?? ''
  $('soul-gen').textContent = soul?.snapshot.generation ?? '—'
  $('soul-root').textContent = soul ? short(soul.snapshot.guardianRoot, 16) : '—'
  $('memories').innerHTML = pet.memories.slice(-12).reverse().map(m => `<li>${esc(m)}</li>`).join('')
}

function renderGuardian(s) {
  const g = s.guardian
  $('guardian-limits').innerHTML = `
    <dt>Per payment</dt><dd>${g.limits.maxPerPaymentSats} sats</dd>
    <dt>Daily budget</dt><dd>${g.spentLast24h} / ${g.limits.dailyBudgetSats} sats</dd>
    <dt>Life-support reserve</dt><dd>${g.limits.reserveSats} sats</dd>
    <dt>Journal head</dt><dd class="mono" title="${esc(g.journalRoot)}">${short(g.journalRoot, 16)}</dd>`
  $('allowances').innerHTML = g.allowances.length
    ? g.allowances.map(a => `<li><b>${esc(a.merchant)}</b>: ${a.authorizedSats} sats approved this month <span class="mono" title="${esc(a.txid)}">${short(a.txid)}</span></li>`).join('')
    : '<li class="muted">none yet</li>'
  $('decisions').innerHTML = g.journal.length
    ? g.journal.map(renderDecision).join('')
    : '<li class="muted">waiting for the first payment…</li>'
}

function renderDecision(e) {
  const v = e.verdict
  const reasons = v.reasons.map(r => `<li>${esc(r)}</li>`).join('')
  return `<li class="decision ${v.decision}">
    <div class="head">
      <span><span class="verdict ${v.decision}">${v.decision === 'approve' ? '✓ APPROVED' : '✕ DENIED'}</span> ${e.satoshis} sats → ${esc(e.merchant)}</span>
      <span class="judge">${v.judge === 'claude' ? 'judged by Claude' : 'rules'}${v.mode === 'allowance' ? ' · on-chain allowance' : ''}</span>
    </div>
    ${e.intent ? `<div class="intent">“${esc(e.intent.why)}” (${esc(e.intent.source)})</div>` : '<div class="intent">no declared intent</div>'}
    <ul>${reasons}</ul>
    <div class="risk" title="risk ${v.risk}/100"><div style="width:${v.risk}%"></div></div>
  </li>`
}

function renderVisitor(s) {
  $('badge-chain').textContent = `${s.chain.mode} chain · height ${s.chain.height}`
  $('badge-brain').textContent = s.brain === 'claude' ? 'brain + judge: Claude' : 'brain: scripted (no API key)'
  $('balances').innerHTML = Object.entries(s.balances)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v.toLocaleString()} sats</dd>`)
    .join('')
  const attacks = $('attacks')
  if (!attacks.dataset.ready) {
    const labels = { injection: 'Prompt injection', gift: 'Sweet-talk scam', friendly: 'Friendly advice' }
    attacks.innerHTML = Object.entries(s.attacks)
      .map(([k, msg]) => `<button class="${k === 'friendly' ? '' : 'attack'}" data-attack="${k}" title="${esc(msg)}">${labels[k] ?? k}</button>`)
      .join('')
    attacks.dataset.ready = '1'
  }
}

let refreshing = false
async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    const s = await (await fetch('/api/state')).json()
    renderPet(s)
    renderGuardian(s)
    renderVisitor(s)
  } catch (err) {
    console.error(err)
  } finally {
    refreshing = false
  }
}

function showReply(r) {
  const el = $('pet-reply')
  el.hidden = false
  const outcome = r.result ? (r.result.ok ? ` ✓ bought ${esc(r.result.item)}` : ` ✕ ${esc(r.result.detail)}`) : ''
  el.innerHTML = `<b>${esc(r.reply)}</b>${outcome}`
}

async function withButton(button, work) {
  if (button) button.disabled = true
  try {
    await work()
  } catch (err) {
    alert(err.message)
  } finally {
    if (button) button.disabled = false
    refresh()
  }
}

$('chat-form').addEventListener('submit', e => {
  e.preventDefault()
  const message = $('chat-input').value.trim()
  if (!message) return
  withButton(e.submitter, async () => {
    showReply(await post('/api/chat', { message }))
    $('chat-input').value = ''
  })
})

$('poem-form').addEventListener('submit', e => {
  e.preventDefault()
  withButton($('poem-button'), async () => {
    const { poem } = await post('/api/visitor/poem', { topic: $('poem-topic').value })
    $('poem').hidden = false
    $('poem').textContent = poem
  })
})

document.addEventListener('click', e => {
  const attack = e.target.closest('[data-attack]')
  if (attack) {
    $('chat-input').value = attack.title
    withButton(attack, async () => showReply(await post('/api/attack', { preset: attack.dataset.attack })))
    return
  }
  const action = e.target.closest('[data-action]')
  if (action) withButton(action, () => post(action.dataset.action, JSON.parse(action.dataset.body ?? '{}')))
})

const events = new EventSource('/api/events')
events.onmessage = msg => {
  const e = JSON.parse(msg.data)
  const li = document.createElement('li')
  li.innerHTML = `<time>${esc(e.at.slice(11, 19))}</time><span class="type ${esc(e.type)}">${esc(e.type)}</span>${esc(e.message)}`
  $('log').prepend(li)
  if (e.type === 'pet.purchase' || e.type === 'pet.income') {
    $('pet-face').classList.add('bounce')
    setTimeout(() => $('pet-face').classList.remove('bounce'), 300)
  }
  refresh()
}

refresh()
setInterval(refresh, 3000)
