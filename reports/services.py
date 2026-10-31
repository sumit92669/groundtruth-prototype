"""Business logic: geo helpers, aggregation, rule-based moderation."""
from datetime import timedelta
from math import asin, cos, radians, sin, sqrt

from django.db.models import Avg
from django.utils import timezone

from .models import PARAMS, AreaScore, Report

RATE_LIMIT_PER_HOUR = 10
DUPLICATE_RADIUS_M = 20
DUPLICATE_WINDOW = timedelta(minutes=5)


def haversine_m(lat1, lng1, lat2, lng2):
    lat1, lng1, lat2, lng2 = map(radians, (lat1, lng1, lat2, lng2))
    a = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lng2 - lng1) / 2) ** 2
    return 2 * 6371000 * asin(sqrt(a))


def nearest_area(lat, lng):
    """Closest AreaScore whose radius contains the point, else None."""
    best, best_d = None, None
    for area in AreaScore.objects.all():
        d = haversine_m(lat, lng, area.center_lat, area.center_lng)
        if d <= area.radius_m and (best_d is None or d < best_d):
            best, best_d = area, d
    return best


def recompute_area(area):
    """Aggregate all non-flagged reports into the area's scores (composite = mean x 10)."""
    qs = Report.objects.filter(area=area, is_flagged=False)
    n = qs.count()
    if n == 0:
        area.report_count = 0
        area.composite_score = 0
        area.save()
        return area
    avgs = qs.aggregate(**{p: Avg(p) for p in PARAMS})
    for p in PARAMS:
        setattr(area, f'avg_{p}', round(avgs[p], 2))
    area.composite_score = round(sum(avgs.values()) / len(PARAMS) * 10, 1)
    area.report_count = n
    area.save()
    return area


def moderation_reason(user, lat, lng, now=None):
    """Rule-based moderation. Returns '' if OK, else the reason the report is flagged."""
    now = now or timezone.now()
    recent = Report.objects.filter(user=user, created_at__gte=now - timedelta(hours=1))
    if recent.count() >= RATE_LIMIT_PER_HOUR:
        return 'rate_limit'
    for r in recent.filter(created_at__gte=now - DUPLICATE_WINDOW):
        if haversine_m(lat, lng, r.latitude, r.longitude) <= DUPLICATE_RADIUS_M:
            return 'duplicate'
    return ''
