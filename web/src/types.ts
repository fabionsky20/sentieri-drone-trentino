// Formato dei file in data/processed/ (vedi docs/DATA.md §4).

export type Colore = 'verde' | 'giallo' | 'rosso'
export type TipoRosso = 'vietato' | 'autorizzazione' | null

export interface Restriction {
  colore: Colore
  tipo_rosso: TipoRosso
  quota_max_m: number | null
}

export interface SegmentProps extends Restriction {
  id: string
  sentiero_id: string
  numero: string
  zone: string // id zone permanenti, separati da virgola
  zone_temporanee: string // id NOTAM, separati da virgola
  lunghezza_m: number
}

export interface ZoneProps extends Restriction {
  zona_id: string
  nome: string
  categoria: string
  restrizione: string
  motivi: string
  messaggio: string | null
  permanente: boolean
  inizio: string | null
  fine: string | null
  quota_min_m: number
  quota_sup_m: number | null
  riferimento: string
  ente: string | null
  ente_servizio: string | null
  ente_email: string | null
  ente_telefono: string | null
  ente_contatto: string | null
  ente_sito: string | null
  sui_sentieri: boolean
}

export interface Trail {
  id: string
  numero: string
  nome: string | null
  titolo: string
  difficolta: string | null
  loc_inizio: string | null
  loc_fine: string | null
  quota_inizio: number | null
  quota_fine: number | null
  quota_min: number | null
  quota_max: number | null
  lunghezza_m: number | null
  lunghezza_inclinata_m: number | null
  tempo_andata: string | null
  tempo_ritorno: string | null
  gruppo_montuoso: string | null
  comuni: string[]
  competenza: string | null
  km_verde: number
  km_giallo: number
  km_rosso: number
  zone_temporanee: string[]
  bbox: [number, number, number, number]
}

export interface Meta {
  titolo: string
  snapshot: string | null // ora italiana, senza fuso
  sentieri: number
  tratti: number
}

export type FC<P> = GeoJSON.FeatureCollection<GeoJSON.Geometry, P>
