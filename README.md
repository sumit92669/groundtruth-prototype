# GroundTruth — class-demo prototype (team CIVICeye)

Crowdsourced, hyperlocal civic review platform: geotagged reports → street/area scores → map for citizens, dashboard for authorities.

**Stack:** Django + Django REST Framework (JWT), SQLite, vanilla JS + Leaflet + OpenStreetMap. No API keys, no GDAL/PostGIS, no Redis needed.
(Locations are plain lat/lng floats; the model maps directly onto GeoDjango/PostGIS for production.)

## Run it (about 2 minutes)

```bash
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py seed_demo        # 6 Bengaluru areas, ~230 reports, demo users
python manage.py runserver
```
Open **http://127.0.0.1:8000** (needs internet once for the OpenStreetMap tiles).

| Role | Username | Password |
|---|---|---|
| Citizen | `demo` | `demo1234` |
| Authority / Django admin | `admin` | `admin1234` |

Also: Swagger API docs at `/api/docs/`, moderation panel at `/admin/`. Run tests: `python manage.py test`.

## Quick Vercel demo deployment

Vercel can auto-detect this Django project from `manage.py`; use the repository root as the project root and leave the build, output, and install settings at their defaults. No environment variables or external database are required for a demo deployment.

On Vercel, the app initializes its demo data in temporary SQLite storage on first start. New accounts, reports, and uploaded photos are temporary and can reset or differ between serverless instances. This no-configuration demo also uses a public signing key and publicly known demo login passwords. Do not use it for real accounts or data; use a private `DJANGO_SECRET_KEY`, persistent database, and file storage before production use.

## 3-minute demo script
1. **Open the map** — green / amber / red pins across six areas. Point out the filter chips (Cleanliness, Safety, Lighting…) recoloring the pins.
2. **Click a red pin in BTM Layout or Whitefield** — score card shows the area score, five parameter bars and recent resident comments. "Streets in view" ranks streets best → worst.
3. **Sign in → "Demo login — Citizen"**, click **+ New Report**, choose **Pick on map**, click a spot in HSR Layout, set Street lighting low, add a photo, submit.
4. **Watch the toast**: "HSR Layout score: 56 → 55". The new pin pulses on the map — this is the live aggregation moment.
5. **Submit the same spot again** — it is held for moderation (duplicate within 20 m / 5 min) and excluded from scores.
6. **Sign in as Authority** → **Authority dashboard**: KPI cards, area heatmap circles, Top Recurring Issues. Click **Resolve** on one and watch it drop off.
7. Mention the **Official statistics** card: clearly labeled *illustrative*, city-level only, never merged into community scores (real source: NCRB "Crime in India" via data.gov.in).

## How it maps to the pitch
- **Aggregation engine:** `reports/services.py::recompute_area` (plain function in the prototype; Celery in production).
- **Rule-based moderation:** `services.py::moderation_reason` — >10 reports/hour or duplicate within 20 m/5 min.
- **Flagged reports** never count toward scores; staff can un/flag in `/admin/` and scores recompute.

## Endpoints
`POST /api/auth/token/` · `POST /api/auth/register/` · `GET /api/me/` · `GET|POST /api/reports/` (`?lat=&lng=&radius=` for nearby) · `GET /api/areas/` · `GET /api/areas/<id>/` · `GET /api/authority/summary/` · `POST /api/authority/resolve/` · `GET /api/official-data/`

## Known prototype limits
Demo area-score data is currently seeded only for Bengaluru; the map and report feed use the device location (10 km radius) when permission is granted · official stats are illustrative mock data for selected cities · no ML moderation (planned post-MVP) · no native mobile app (the web app is responsive) · SQLite instead of PostGIS · scores recompute synchronously.
