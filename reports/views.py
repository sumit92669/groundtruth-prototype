from collections import defaultdict
from datetime import timedelta

from django.utils import timezone
from rest_framework import generics, permissions, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from .models import PARAM_LABELS, PARAMS, AreaScore, Report
from .serializers import AreaScoreSerializer, RegisterSerializer, ReportSerializer
from .services import haversine_m, moderation_reason, nearest_area, recompute_area

POOR_BELOW = 50  # composite score under this = "poor"


class IsAuthority(permissions.BasePermission):
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_staff)


@api_view(['POST'])
def register(request):
    ser = RegisterSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    user = ser.save()
    refresh = RefreshToken.for_user(user)
    return Response({'access': str(refresh.access_token), 'refresh': str(refresh)}, status=201)


@api_view(['GET'])
@permission_classes([permissions.IsAuthenticated])
def me(request):
    return Response({'username': request.user.username, 'is_authority': request.user.is_staff})


class ReportListCreate(generics.GenericAPIView):
    """GET: public list of non-flagged reports (optionally within `radius` metres of lat/lng).
    POST: create a report (auth). Rule-based moderation runs before aggregation."""
    serializer_class = ReportSerializer
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_permissions(self):
        return [permissions.IsAuthenticated()] if self.request.method == 'POST' else [permissions.AllowAny()]

    def get(self, request):
        qs = Report.objects.filter(is_flagged=False).select_related('user', 'area')
        try:
            lat, lng = float(request.query_params['lat']), float(request.query_params['lng'])
            radius = float(request.query_params.get('radius', 1000))
        except (KeyError, ValueError):
            return Response(self.get_serializer(qs[:1000], many=True).data)
        # cheap bounding box first, then exact haversine
        d = radius / 111000.0
        qs = qs.filter(latitude__range=(lat - d, lat + d), longitude__range=(lng - 2 * d, lng + 2 * d))
        near = [r for r in qs if haversine_m(lat, lng, r.latitude, r.longitude) <= radius]
        return Response(self.get_serializer(near, many=True).data)

    def post(self, request):
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        v = ser.validated_data
        reason = moderation_reason(request.user, v['latitude'], v['longitude'])
        area = nearest_area(v['latitude'], v['longitude'])
        if area is None and not reason:
            # Let a new city/neighbourhood start accumulating scores instead of
            # forcing every report to belong to one of the Bengaluru demo areas.
            street = (v.get('street_name') or '').strip()
            label = street[:70] if street else f"Local area {v['latitude']:.4f}, {v['longitude']:.4f}"
            name = f"{label} ({v['latitude']:.4f}, {v['longitude']:.4f})"[:120]
            area = AreaScore.objects.create(
                name=name, center_lat=v['latitude'], center_lng=v['longitude'], radius_m=1500
            )
        report = ser.save(user=request.user, area=area, is_flagged=bool(reason), flag_reason=reason)
        if area and not reason:
            recompute_area(area)
            area.refresh_from_db()
        data = ReportSerializer(report).data
        data['flagged'] = bool(reason)
        data['flag_reason'] = reason
        data['area_score'] = area.composite_score if area else None
        return Response(data, status=status.HTTP_201_CREATED)


def street_breakdown(reports):
    """Group reports by street and return per-street 0-100 scores, worst first."""
    groups = defaultdict(list)
    for r in reports:
        if r.street_name:
            groups[r.street_name].append(r)
    out = []
    for name, rs in groups.items():
        score = sum(getattr(r, p) for r in rs for p in PARAMS) / (len(rs) * len(PARAMS)) * 10
        out.append({'street': name, 'score': round(score, 1), 'report_count': len(rs)})
    return sorted(out, key=lambda s: s['score'])


class AreaList(generics.ListAPIView):
    serializer_class = AreaScoreSerializer
    pagination_class = None

    def get_queryset(self):
        qs = AreaScore.objects.all().order_by('name')
        try:
            lat = float(self.request.query_params['lat'])
            lng = float(self.request.query_params['lng'])
            radius = max(0, float(self.request.query_params.get('radius', 10000)))
        except (KeyError, ValueError):
            return qs
        # Include areas whose centre is within the requested radius plus the
        # area's own coverage radius, so edge areas are not unexpectedly lost.
        return [area for area in qs if haversine_m(
            lat, lng, area.center_lat, area.center_lng
        ) <= radius + area.radius_m]


class AreaDetail(generics.RetrieveAPIView):
    queryset = AreaScore.objects.all()
    serializer_class = AreaScoreSerializer

    def retrieve(self, request, *args, **kwargs):
        area = self.get_object()
        reports = list(area.reports.filter(is_flagged=False).select_related('user'))
        data = AreaScoreSerializer(area).data
        data['recent_reports'] = ReportSerializer(reports[:6], many=True).data
        data['streets'] = street_breakdown(reports)
        return Response(data)


@api_view(['GET'])
@permission_classes([IsAuthority])
def authority_summary(request):
    now = timezone.now()
    live = list(Report.objects.filter(is_flagged=False).select_related('area'))
    areas = list(AreaScore.objects.all())
    scored = [a for a in areas if a.report_count]
    per_street = defaultdict(list)
    for r in live:
        per_street[(r.area_id, r.street_name)].append(r)
    poor_streets = sum(
        1 for rs in per_street.values()
        if sum(getattr(r, p) for r in rs for p in PARAMS) / (len(rs) * len(PARAMS)) * 10 < POOR_BELOW
    )
    issues = defaultdict(int)  # (area, param) -> unresolved low-rating reports
    for r in live:
        if r.area_id and not r.is_resolved:
            for p in PARAMS:
                if getattr(r, p) <= 4:
                    issues[(r.area_id, p)] += 1
    names = {a.id: a.name for a in areas}
    top = sorted(issues.items(), key=lambda kv: -kv[1])[:8]
    return Response({
        'kpis': {
            'active_reports_30d': sum(1 for r in live if r.created_at >= now - timedelta(days=30)),
            'avg_area_score': round(sum(a.composite_score for a in scored) / len(scored), 1) if scored else 0,
            'streets_flagged_poor': poor_streets,
            'issues_resolved': sum(1 for r in live if r.is_resolved),
        },
        'top_issues': [
            {'area': aid, 'area_name': names[aid], 'parameter': p, 'label': PARAM_LABELS[p],
             'count': n, 'severity': 'poor' if n >= 10 else 'attention'}
            for (aid, p), n in top
        ],
        'areas': AreaScoreSerializer(areas, many=True).data,
    })


@api_view(['POST'])
@permission_classes([IsAuthority])
def resolve_issue(request):
    """Mark an (area, parameter) issue resolved: all its low-rated open reports become resolved."""
    area, param = request.data.get('area'), request.data.get('parameter')
    if param not in PARAMS or not area:
        return Response({'detail': 'area and a valid parameter are required.'}, status=400)
    n = Report.objects.filter(area_id=area, is_resolved=False, **{f'{param}__lte': 4}).update(is_resolved=True)
    return Response({'resolved_reports': n})


# Illustrative stand-in for NCRB "Crime in India" city-wise tables. NOT real figures.
# Real source: NCRB via data.gov.in (annual, city/district level only; no live police API exists).
ILLUSTRATIVE_CRIME = {
    'Bengaluru': [('Theft', 188.4), ('Cheating', 41.2), ('Hurt', 24.7)],
    'Delhi': [('Theft', 312.9), ('Cheating', 52.3), ('Hurt', 31.5)],
    'Mumbai': [('Theft', 141.6), ('Cheating', 36.8), ('Hurt', 19.2)],
    'Chennai': [('Theft', 97.5), ('Cheating', 22.1), ('Hurt', 17.4)],
}


@api_view(['GET'])
def official_data(request):
    city = request.query_params.get('city', '').strip()
    rows = ILLUSTRATIVE_CRIME.get(city, [])
    return Response({
        'city': city or 'Unknown location',
        'granularity': 'City level (never mapped to streets)',
        'illustrative': True,
        'note': ('Illustrative data only. Real source: NCRB \"Crime in India\" city-wise tables via data.gov.in.' if rows else 'No illustrative figures are configured for this city. Missing data does not mean zero crime.'),
        'rows': [{'crime_head': h, 'rate_per_lakh': v} for h, v in rows],
    })
