// Pagina profilo, hangar droni, documenti del pilota e onboarding del primo accesso.
// REGOLA FISSA: qui non si chiede, registra o mostra mai la quota a cui si è volato.

import type { AccountState, Drone, DroneClass, DroneInput, Profile, ProfilePatch } from './account'
import { segmented } from './filters'
import { dotDate, h } from './panel'
import { icon } from './ui'

export const WARN_DAYS = 30

/** Modelli comuni: compilano classe e peso quando si sceglie il modello. */
const PRESETS: { modello: string; classe: DroneClass; peso_g: number }[] = [
  { modello: 'DJI Mini 4 Pro', classe: 'C0', peso_g: 249 },
  { modello: 'DJI Mini 3 Pro', classe: 'C0', peso_g: 249 },
  { modello: 'DJI Mini 3', classe: 'C0', peso_g: 248 },
  { modello: 'DJI Mini 2', classe: 'legacy', peso_g: 249 },
  { modello: 'DJI Mini 2 SE', classe: 'C0', peso_g: 246 },
  { modello: 'DJI Mini 4K', classe: 'C0', peso_g: 249 },
  { modello: 'DJI Mini SE', classe: 'legacy', peso_g: 249 },
  { modello: 'DJI Neo', classe: 'C0', peso_g: 135 },
  { modello: 'DJI Flip', classe: 'C0', peso_g: 249 },
  { modello: 'DJI Air 3', classe: 'C1', peso_g: 720 },
  { modello: 'DJI Air 3S', classe: 'C1', peso_g: 724 },
  { modello: 'DJI Mavic 3 Classic', classe: 'C1', peso_g: 895 },
  { modello: 'DJI Avata 2', classe: 'C1', peso_g: 377 },
]
const CLASSI: DroneClass[] = ['C0', 'C1', 'C2', 'legacy']

export interface ProfileActions {
  login: () => void
  logout: () => void
  retry: () => void
  updateProfile: (p: ProfilePatch) => Promise<void>
  saveDrone: (d: DroneInput, id?: string) => Promise<void>
  removeDrone: (id: string) => Promise<void>
  deleteAccount: () => Promise<void>
  zoneSuggestions: string[]
}

// ---------------------------------------------------------------- scadenze

/** Giorni da oggi (locale) alla data AAAA-MM-GG; negativo se già passata. */
export function daysTo(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86_400_000)
}

export interface Expiry {
  what: string
  date: string
  days: number
}

/** Scadenze entro WARN_DAYS giorni o già passate: documenti del pilota e assicurazioni. */
export function expiries(profile: Profile | null, droni: Drone[]): Expiry[] {
  const out: Expiry[] = []
  const add = (what: string, date: string | null) => {
    if (!date) return
    const days = daysTo(date)
    if (days <= WARN_DAYS) out.push({ what, date, days })
  }
  add('Attestato A1/A3', profile?.attestato_scadenza ?? null)
  add('Abbonamento D-Flight', profile?.dflight_scadenza ?? null)
  for (const d of droni) add(`Assicurazione ${d.modello}`, d.assicurazione_scadenza)
  return out.sort((a, b) => a.days - b.days)
}

const expiryText = (e: Expiry) =>
  e.days < 0 ? `scaduta il ${dotDate(e.date)}` : e.days === 0 ? 'scade oggi' : `scade tra ${e.days} ${e.days === 1 ? 'giorno' : 'giorni'} (${dotDate(e.date)})`

function expiryBox(list: Expiry[]): HTMLElement | null {
  if (!list.length) return null
  return h(
    'section',
    { class: `notice ${list.some((e) => e.days < 0) ? 'danger' : 'attention'}` },
    h('p', { class: 'section-label' }, 'Scadenze'),
    h('ul', {}, ...list.map((e) => h('li', {}, h('strong', {}, e.what), ' ', h('span', { class: 'mono' }, expiryText(e))))),
  )
}

// ---------------------------------------------------------------- componenti

export function avatarEl(src: string | null, name: string, size = 40): HTMLElement {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
  const el = h('span', { class: 'avatar', style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px` }, initials || '?')
  if (src) {
    const img = h('img', { src, alt: '', referrerpolicy: 'no-referrer', width: String(size), height: String(size) }) as HTMLImageElement
    img.addEventListener('error', () => img.remove()) // foto non raggiungibile: restano le iniziali
    el.append(img)
  }
  return el
}

function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  // <label> solo attorno a un vero campo: attorno a un gruppo di pulsanti (classe del drone)
  // un tocco sull'etichetta premerebbe sempre il primo pulsante.
  const isInput = input instanceof HTMLInputElement || input instanceof HTMLSelectElement
  const k = h('span', { class: 'field-k' }, labelText)
  const wrap = isInput ? h('label', { class: 'field' }, k, input) : h('div', { class: 'field', role: 'group', 'aria-label': labelText }, k, input)
  if (hint) wrap.append(h('span', { class: 'hint' }, hint))
  return wrap
}

function textInput(value: string | null, attrs: Record<string, string> = {}): HTMLInputElement {
  const el = h('input', { type: 'text', ...attrs }) as HTMLInputElement
  el.value = value ?? ''
  return el
}

function dateInput(value: string | null): HTMLInputElement {
  const el = h('input', { type: 'date' }) as HTMLInputElement
  el.value = value ?? ''
  return el
}

function datalist(id: string, values: string[]): HTMLElement {
  const dl = h('datalist', { id })
  for (const v of values) dl.append(h('option', { value: v }))
  return dl
}

/** Esegue un'azione asincrona disabilitando il pulsante; mostra l'errore sotto. */
async function busy(btn: HTMLButtonElement, fn: () => Promise<void>, errorBox: HTMLElement): Promise<boolean> {
  btn.disabled = true
  errorBox.textContent = ''
  try {
    await fn()
    return true
  } catch (e) {
    errorBox.textContent = `Non riuscito: ${(e as Error).message}`
    return false
  } finally {
    btn.disabled = false
  }
}

// ---------------------------------------------------------------- modulo drone

function droneForm(initial: Drone | null, onSave: (d: DroneInput) => Promise<void>, onCancel: (() => void) | null): HTMLElement {
  const err = h('p', { class: 'warn small' })
  const modello = textInput(initial?.modello ?? '', { list: 'dl-droni', placeholder: 'es. DJI Mini 4 Pro', maxlength: '60', autocomplete: 'off' })
  let classe: DroneClass = initial?.classe ?? 'C0'
  const classeBox = h('div', {})
  const drawClasse = () =>
    classeBox.replaceChildren(
      segmented<DroneClass>(CLASSI.map((c) => [c, c === 'legacy' ? 'Legacy' : c]), classe, (v) => (classe = v), 'small'),
    )
  drawClasse()
  const peso = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '25000', placeholder: 'g' }) as HTMLInputElement
  if (initial) peso.value = String(initial.peso_g)
  const ass = dateInput(initial?.assicurazione_scadenza ?? null)
  // Scegliendo un modello noto, classe e peso si compilano da soli.
  modello.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.modello.toLowerCase() === modello.value.trim().toLowerCase())
    if (!p) return
    classe = p.classe
    drawClasse()
    peso.value = String(p.peso_g)
  })
  const save = h('button', { type: 'submit', class: 'btn-primary' }, initial ? 'SALVA' : 'AGGIUNGI DRONE') as HTMLButtonElement
  const form = h(
    'form',
    { class: 'droneform' },
    datalist('dl-droni', PRESETS.map((p) => p.modello)),
    field('Modello', modello),
    field('Classe', classeBox, 'C0 < 250 g · "Legacy" = senza marcatura di classe'),
    h('div', { class: 'row2' }, field('Peso (g)', peso), field('Assicurazione: scadenza', ass)),
    err,
    h('div', { class: 'form-actions' }, save),
  )
  if (onCancel) {
    const cancel = h('button', { type: 'button', class: 'btn-text' }, 'ANNULLA')
    cancel.addEventListener('click', onCancel)
    form.querySelector('.form-actions')!.prepend(cancel)
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const m = modello.value.trim()
    const g = Number(peso.value)
    if (!m) return void (err.textContent = 'Scrivi il modello.')
    if (!Number.isFinite(g) || g < 1 || g > 25000) return void (err.textContent = 'Peso tra 1 e 25.000 g.')
    await busy(save, () => onSave({ modello: m, classe, peso_g: g, assicurazione_scadenza: ass.value || null }), err)
  })
  return form
}

function droneCard(d: Drone, a: ProfileActions, onEdit: () => void): HTMLElement {
  const days = d.assicurazione_scadenza ? daysTo(d.assicurazione_scadenza) : null
  const ins = d.assicurazione_scadenza
    ? h('span', { class: `mono ${days! < 0 ? 'bad' : days! <= WARN_DAYS ? 'soon' : 'muted'}` }, `assic. ${dotDate(d.assicurazione_scadenza)}`)
    : h('span', { class: 'mono muted' }, 'assicurazione: —')
  const edit = h('button', { type: 'button', class: 'iconbtn', 'aria-label': `Modifica ${d.modello}`, title: 'Modifica' }, icon('edit', 18))
  edit.addEventListener('click', onEdit)
  const del = h('button', { type: 'button', class: 'iconbtn', 'aria-label': `Togli ${d.modello}`, title: 'Togli dall’hangar' }, icon('close', 18))
  del.addEventListener('click', async () => {
    if (confirm(`Togliere ${d.modello} dall'hangar?`)) await a.removeDrone(d.id)
  })
  return h(
    'li',
    { class: 'dronecard' },
    h(
      'div',
      { class: 'drone-main' },
      h('span', { class: 'card-title' }, d.modello),
      h('span', { class: 'drone-meta' }, h('span', { class: 'pill tiny' }, d.classe === 'legacy' ? 'LEGACY' : d.classe), h('span', { class: 'mono' }, `${d.peso_g} g`), ins),
    ),
    edit,
    del,
  )
}

function hangar(st: AccountState, a: ProfileActions, rerender: () => void): HTMLElement {
  const wrap = h('section', { class: 'hangar' })
  const head = h('div', { class: 'section-head' }, h('p', { class: 'section-label' }, `Hangar · ${st.droni.length}`))
  const list = h('ul', { class: 'cards' })
  for (const d of st.droni) {
    const li = droneCard(d, a, () => {
      li.replaceWith(h('li', { class: 'card editing' }, droneForm(d, async (x) => { await a.saveDrone(x, d.id); rerender() }, rerender)))
    })
    list.append(li)
  }
  const add = h('button', { type: 'button', class: 'btn-outline wide' }, icon('plus', 18), 'AGGIUNGI DRONE')
  add.addEventListener('click', () => {
    add.replaceWith(h('div', { class: 'card editing' }, droneForm(null, async (x) => { await a.saveDrone(x); rerender() }, rerender)))
  })
  wrap.append(head, st.droni.length ? list : h('p', { class: 'muted small' }, 'Nessun drone nell’hangar.'), add)
  return wrap
}

function documents(p: Profile, a: ProfileActions): HTMLElement {
  const row = (title: string, key: 'attestato_scadenza' | 'dflight_scadenza', hint: string) => {
    const input = dateInput(p[key])
    const status = h('span', { class: 'mono small' })
    const show = () => {
      if (!input.value) return void ((status.textContent = 'non indicata'), (status.className = 'mono small muted'))
      const d = daysTo(input.value)
      status.textContent = d < 0 ? 'SCADUTO' : d <= WARN_DAYS ? `tra ${d} gg` : 'valido'
      status.className = `mono small ${d < 0 ? 'bad' : d <= WARN_DAYS ? 'soon' : 'ok'}`
    }
    show()
    input.addEventListener('change', async () => {
      show()
      await a.updateProfile({ [key]: input.value || null })
    })
    return h('div', { class: 'docrow' }, h('div', {}, h('span', { class: 'docrow-title' }, title), h('span', { class: 'hint' }, hint)), h('div', { class: 'docrow-input' }, input, status))
  }
  return h(
    'section',
    {},
    h('p', { class: 'section-label' }, 'Documenti del pilota'),
    row('Attestato A1/A3', 'attestato_scadenza', 'scadenza dell’attestato online'),
    row('Abbonamento D-Flight', 'dflight_scadenza', 'scadenza della registrazione operatore'),
  )
}

function identity(st: AccountState, a: ProfileActions, rerender: () => void): HTMLElement {
  const p = st.profile!
  const edit = h('button', { type: 'button', class: 'btn-text' }, 'MODIFICA')
  const box = h(
    'div',
    { class: 'identity' },
    avatarEl(p.avatar, p.nome, 72),
    h('div', { class: 'identity-text' }, h('h2', { class: 'title' }, p.nome), h('p', { class: 'subtitle' }, p.zona ? `Zona: ${p.zona}` : 'Zona di casa non indicata'), h('p', { class: 'mono small muted' }, st.user?.email ?? '')),
    edit,
  )
  edit.addEventListener('click', () => {
    const err = h('p', { class: 'warn small' })
    const nome = textInput(p.nome, { maxlength: '60', autocomplete: 'nickname' })
    const zona = textInput(p.zona, { maxlength: '80', list: 'dl-zone', placeholder: 'es. Valsugana' })
    const save = h('button', { type: 'submit', class: 'btn-primary' }, 'SALVA') as HTMLButtonElement
    const cancel = h('button', { type: 'button', class: 'btn-text' }, 'ANNULLA')
    cancel.addEventListener('click', rerender)
    const form = h('form', { class: 'identity-form' }, datalist('dl-zone', a.zoneSuggestions), field('Nome visualizzato', nome), field('Zona di casa', zona), err, h('div', { class: 'form-actions' }, cancel, save))
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      if (!nome.value.trim()) return void (err.textContent = 'Il nome non può essere vuoto.')
      if (await busy(save, () => a.updateProfile({ nome: nome.value.trim().slice(0, 60), zona: zona.value.trim().slice(0, 80) || null }), err)) rerender()
    })
    box.replaceWith(form)
  })
  return box
}

function dangerZone(a: ProfileActions): HTMLElement {
  const out = h('button', { type: 'button', class: 'btn-outline wide' }, icon('logout', 18), 'ESCI')
  out.addEventListener('click', a.logout)
  const del = h('button', { type: 'button', class: 'btn-danger wide' }, 'ELIMINA ACCOUNT')
  const err = h('p', { class: 'warn small' })
  del.addEventListener('click', async () => {
    const ok = confirm(
      'Eliminare l’account?\n\nVerranno cancellati per sempre: profilo, hangar, sentieri salvati e i sentieri che hai aggiunto alla lista condivisa. Potrebbe esserti chiesto di confermare con Google.',
    )
    if (!ok) return
    await busy(del as HTMLButtonElement, a.deleteAccount, err)
  })
  return h('section', { class: 'account-actions' }, out, del, err)
}

// ---------------------------------------------------------------- pagina profilo

export function renderProfilePage(st: AccountState | null, a: ProfileActions, rerender: () => void): HTMLElement[] {
  if (!st || st.status === 'caricamento' || (st.status === 'pronto' && !st.profile)) {
    return [h('p', { class: 'muted' }, 'Caricamento…')]
  }
  if (st.status === 'anonimo') {
    const b = h('button', { type: 'button', class: 'btn-primary wide' }, 'ACCEDI CON GOOGLE')
    b.addEventListener('click', a.login)
    return [
      h(
        'div',
        { class: 'empty-state' },
        icon('user', 32),
        h('p', {}, 'Accedi con Google per avere il tuo profilo, l’hangar dei droni con le scadenze e i sentieri salvati, sincronizzati su telefono e PC.'),
        h('p', { class: 'small' }, 'Mappa, filtri e schede funzionano anche senza accesso.'),
      ),
      b,
    ]
  }
  if (st.status === 'errore') {
    const b = h('button', { type: 'button', class: 'btn-primary' }, 'RIPROVA')
    b.addEventListener('click', a.retry)
    const out = h('button', { type: 'button', class: 'btn-text' }, 'ESCI')
    out.addEventListener('click', a.logout)
    return [h('p', { class: 'warn' }, `Errore: ${st.errore}`), h('div', { class: 'form-actions' }, out, b)]
  }
  const p = st.profile!
  return [
    identity(st, a, rerender),
    expiryBox(expiries(p, st.droni)),
    hangar(st, a, rerender),
    documents(p, a),
    h(
      'section',
      {},
      h('p', { class: 'section-label' }, 'Statistiche'),
      h('div', { class: 'tiles three placeholder' }, ...['SENTIERI FATTI', 'KM', 'GRUPPI'].map((k) => h('div', { class: 'tile' }, h('span', { class: 'tile-k' }, k), h('span', { class: 'tile-v off' }, '—')))),
      h('p', { class: 'hint' }, 'In arrivo: sentieri segnati come fatti e statistiche, private per impostazione.'),
    ),
    dangerZone(a),
  ].filter((x): x is HTMLElement => !!x)
}

// ---------------------------------------------------------------- onboarding

/** Tre schermate saltabili al primo accesso: nome, zona di casa, droni. */
export function renderOnboarding(st: AccountState, a: ProfileActions, step: number, go: (step: number | 'fine') => void): HTMLElement {
  const p = st.profile!
  const err = h('p', { class: 'warn small' })
  const steps = ['Come ti chiami?', 'Dove abiti?', 'Che droni usi?']
  const dots = h('div', { class: 'ob-dots', 'aria-hidden': 'true' }, ...steps.map((_, i) => h('i', { class: i === step ? 'on' : '' })))
  const skipAll = h('button', { type: 'button', class: 'btn-text' }, 'SALTA TUTTO')
  skipAll.addEventListener('click', () => go('fine'))
  const body = h('div', { class: 'ob-body' })
  const next = h('button', { type: 'button', class: 'btn-primary wide' }, step < 2 ? 'AVANTI' : 'INIZIA') as HTMLButtonElement
  const skip = h('button', { type: 'button', class: 'btn-text' }, 'SALTA')
  skip.addEventListener('click', () => go(step < 2 ? step + 1 : 'fine'))

  if (step === 0) {
    const nome = textInput(p.nome, { maxlength: '60', autocomplete: 'nickname' })
    body.append(h('p', { class: 'muted' }, 'Il nome che vedranno i tuoi amici nelle bacheche condivise.'), field('Nome visualizzato', nome))
    next.addEventListener('click', async () => {
      if (!nome.value.trim()) return void (err.textContent = 'Il nome non può essere vuoto.')
      if (await busy(next, () => a.updateProfile({ nome: nome.value.trim().slice(0, 60) }), err)) go(1)
    })
  } else if (step === 1) {
    const zona = textInput(p.zona, { maxlength: '80', list: 'dl-zone-ob', placeholder: 'es. Valsugana, Trento, Val di Fassa' })
    body.append(datalist('dl-zone-ob', a.zoneSuggestions), h('p', { class: 'muted' }, 'Servirà a proporti sentieri vicini a casa.'), field('Zona di casa', zona))
    next.addEventListener('click', async () => {
      if (await busy(next, () => a.updateProfile({ zona: zona.value.trim().slice(0, 80) || null }), err)) go(2)
    })
  } else {
    const list = h('ul', { class: 'cards' }, ...st.droni.map((d) => h('li', { class: 'card ob-drone' }, h('span', { class: 'card-title' }, d.modello), h('span', { class: 'mono muted' }, `${d.classe} · ${d.peso_g} g`))))
    body.append(
      h('p', { class: 'muted' }, 'Aggiungi i droni che usi: potrai completarli dopo nel profilo (assicurazione, scadenze).'),
      list,
      droneForm(null, (x) => a.saveDrone(x), null),
    )
    next.addEventListener('click', () => go('fine'))
  }

  return h(
    'div',
    { class: 'ob-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ob-title' },
    h('div', { class: 'ob-head' }, dots, skipAll),
    h('p', { class: 'section-label' }, `Benvenuto in Quota 120 · ${step + 1}/3`),
    h('h2', { class: 'title', id: 'ob-title' }, steps[step]),
    body,
    err,
    h('div', { class: 'ob-foot' }, skip, next),
  )
}

