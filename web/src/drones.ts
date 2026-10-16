// Modelli di drone più diffusi: scegliendone uno, classe e peso si compilano da soli.
// Valori indicativi (peso al decollo dichiarato dal produttore, classe UE se marcato):
// l'utente può sempre correggerli, e deve fare fede l'etichetta di classe sul drone.

import type { DroneClass } from './account'

export interface DronePreset {
  modello: string
  classe: DroneClass
  peso_g: number
}

export const DRONE_PRESETS: { marca: string; modelli: DronePreset[] }[] = [
  {
    marca: 'DJI Mini',
    modelli: [
      { modello: 'DJI Mini 5 Pro', classe: 'C0', peso_g: 249 },
      { modello: 'DJI Mini 4 Pro', classe: 'C0', peso_g: 249 },
      { modello: 'DJI Mini 4K', classe: 'C0', peso_g: 249 },
      { modello: 'DJI Mini 3 Pro', classe: 'C0', peso_g: 249 },
      { modello: 'DJI Mini 3', classe: 'C0', peso_g: 248 },
      { modello: 'DJI Mini 2 SE', classe: 'C0', peso_g: 246 },
      { modello: 'DJI Mini 2', classe: 'legacy', peso_g: 249 },
      { modello: 'DJI Mini SE', classe: 'legacy', peso_g: 249 },
      { modello: 'DJI Mavic Mini', classe: 'legacy', peso_g: 249 },
    ],
  },
  {
    marca: 'DJI Air',
    modelli: [
      { modello: 'DJI Air 3S', classe: 'C1', peso_g: 724 },
      { modello: 'DJI Air 3', classe: 'C1', peso_g: 720 },
      { modello: 'DJI Air 2S', classe: 'legacy', peso_g: 595 },
      { modello: 'DJI Mavic Air 2', classe: 'legacy', peso_g: 570 },
    ],
  },
  {
    marca: 'DJI Mavic',
    modelli: [
      { modello: 'DJI Mavic 4 Pro', classe: 'C2', peso_g: 1063 },
      { modello: 'DJI Mavic 3 Pro', classe: 'C2', peso_g: 958 },
      { modello: 'DJI Mavic 3 Classic', classe: 'C1', peso_g: 895 },
      { modello: 'DJI Mavic 3', classe: 'C1', peso_g: 895 },
      { modello: 'DJI Mavic 3 Cine', classe: 'C1', peso_g: 899 },
      { modello: 'DJI Mavic 2 Pro', classe: 'legacy', peso_g: 907 },
      { modello: 'DJI Mavic 2 Zoom', classe: 'legacy', peso_g: 905 },
    ],
  },
  {
    marca: 'DJI FPV e piccoli',
    modelli: [
      { modello: 'DJI Avata 2', classe: 'C1', peso_g: 377 },
      { modello: 'DJI Avata', classe: 'C1', peso_g: 410 },
      { modello: 'DJI FPV', classe: 'legacy', peso_g: 795 },
      { modello: 'DJI Neo', classe: 'C0', peso_g: 135 },
      { modello: 'DJI Flip', classe: 'C0', peso_g: 249 },
    ],
  },
  {
    marca: 'Autel',
    modelli: [
      { modello: 'Autel EVO Nano+', classe: 'C0', peso_g: 249 },
      { modello: 'Autel EVO Nano', classe: 'C0', peso_g: 249 },
      { modello: 'Autel EVO Lite+', classe: 'legacy', peso_g: 835 },
      { modello: 'Autel EVO Lite', classe: 'legacy', peso_g: 835 },
      { modello: 'Autel EVO II Pro V3', classe: 'C2', peso_g: 1191 },
    ],
  },
  {
    marca: 'Potensic',
    modelli: [
      { modello: 'Potensic Atom 2', classe: 'C0', peso_g: 249 },
      { modello: 'Potensic Atom', classe: 'C0', peso_g: 249 },
      { modello: 'Potensic Atom SE', classe: 'C0', peso_g: 249 },
    ],
  },
  {
    marca: 'HoverAir',
    modelli: [
      { modello: 'HoverAir X1 ProMax', classe: 'C0', peso_g: 192 },
      { modello: 'HoverAir X1 Pro', classe: 'C0', peso_g: 192 },
      { modello: 'HoverAir X1', classe: 'C0', peso_g: 125 },
    ],
  },
]

export const ALL_PRESETS: DronePreset[] = DRONE_PRESETS.flatMap((g) => g.modelli)

export const findPreset = (modello: string): DronePreset | undefined =>
  ALL_PRESETS.find((p) => p.modello.toLowerCase() === modello.trim().toLowerCase())
