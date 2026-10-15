"""Percorsi e parametri della pipeline."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
AUTHORITIES_YAML = ROOT / "data" / "authorities.yaml"

# CRS metrico per tutti i calcoli, WGS84 per l'output web.
WORK_CRS = 32632
WEB_CRS = 4326

# Le zone D-Flight vengono tenute se toccano il riquadro dei sentieri allargato di
# questa distanza (m): dà contesto sulla mappa oltre ai soli sentieri.
ZONES_MARGIN_M = 5_000

# Semplificazione delle geometrie in output (m). 2 m è sotto il pixel a zoom 16.
SIMPLIFY_TRAILS_M = 2.0
SIMPLIFY_ZONES_M = 2.0

# Decimali delle coordinate in output: 5 ≈ 1 m.
COORD_PRECISION = 5

# Pezzi di sentiero più corti di così (m) dopo il taglio vengono ignorati
# (artefatti numerici sui bordi delle zone).
MIN_PIECE_M = 0.05

# Limiti superiori oltre questo valore (m) sono placeholder D-Flight per "illimitato".
UNLIMITED_UPPER_M = 10_000

# ---- POI (fase 4)
# Distanza massima (m) tra sentiero e POI per assegnare il badge, per categoria.
POI_DISTANCE_M = {
    "lago": 300,
    "vetta": 150,
    "malga": 150,
    "rifugio": 150,
    "bivacco": 150,
    "cascata": 150,
    "panoramico": 150,
    "passo": 150,
}
# Valli con almeno questa estensione (km) diventano etichette "da lontano".
VALLEY_MAJOR_KM = 8

# ---- DEM e profili (fase 4)
DEM_ZOOM = 13  # ~6,6 m/pixel in Trentino, vicino ai 5 m del LiDAR sorgente
PROFILE_STEP_M = 10  # passo di campionamento per il calcolo del dislivello
GAIN_THRESHOLD_M = 5  # isteresi per il dislivello (vedi dem.gain_loss)
PROFILE_MAX_POINTS = 300  # punti del profilo salvati per la web app, per sentiero
