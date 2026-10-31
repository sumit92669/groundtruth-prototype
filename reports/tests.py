from datetime import timedelta

from django.contrib.auth.models import User
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from .models import AreaScore, Report
from .services import haversine_m, moderation_reason, recompute_area

GOOD = dict(cleanliness=8, road_condition=8, street_lighting=8, safety=8, waterlogging=8)


class GroundTruthTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user('u', password='pw123456')
        self.admin = User.objects.create_user('a', password='pw123456', is_staff=True)
        self.area = AreaScore.objects.create(name='Test', center_lat=12.93, center_lng=77.62, radius_m=2000)
        self.client = APIClient()

    def make(self, user=None, lat=12.93, lng=77.62, **kw):
        vals = {**GOOD, **kw}
        return Report.objects.create(user=user or self.user, area=self.area, latitude=lat, longitude=lng, street_name='S', **vals)

    def test_create_report_assigns_area_and_updates_score(self):
        self.client.force_authenticate(self.user)
        res = self.client.post('/api/reports/', {'latitude': 12.931, 'longitude': 77.621, 'street_name': 'X', **GOOD}, format='json')
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data['area'], self.area.id)
        self.assertEqual(res.data['area_score'], 80.0)

    def test_requires_auth_and_valid_ratings(self):
        body = {'latitude': 12.93, 'longitude': 77.62, **GOOD}
        self.assertEqual(self.client.post('/api/reports/', body, format='json').status_code, 401)
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.post('/api/reports/', {**body, 'safety': 11}, format='json').status_code, 400)

    def test_aggregation_math_ignores_flagged(self):
        self.make(cleanliness=10, road_condition=10, street_lighting=10, safety=10, waterlogging=10)
        self.make(cleanliness=0, road_condition=0, street_lighting=0, safety=0, waterlogging=0)
        bad = self.make(cleanliness=0, road_condition=0, street_lighting=0, safety=0, waterlogging=0)
        Report.objects.filter(pk=bad.pk).update(is_flagged=True)
        recompute_area(self.area)
        self.assertEqual(self.area.composite_score, 50.0)
        self.assertEqual(self.area.report_count, 2)

    def test_nearby_filtering(self):
        self.make(lat=12.9301, lng=77.6201)
        self.make(lat=13.5, lng=77.9)
        res = self.client.get('/api/reports/', {'lat': 12.93, 'lng': 77.62, 'radius': 500})
        self.assertEqual(len(res.data), 1)
        self.assertLess(haversine_m(12.93, 77.62, 12.9301, 77.6201), 20)

    def test_moderation_duplicate_and_rate_limit(self):
        self.make()
        self.assertEqual(moderation_reason(self.user, 12.93, 77.62), 'duplicate')
        self.assertEqual(moderation_reason(self.user, 12.95, 77.65), '')
        other = User.objects.create_user('o', password='pw123456')
        for i in range(10):
            r = self.make(user=other, lat=12.9 + i * 0.01)
            Report.objects.filter(pk=r.pk).update(created_at=timezone.now() - timedelta(minutes=20))
        self.assertEqual(moderation_reason(other, 12.5, 77.5), 'rate_limit')

    def test_flagged_report_excluded_from_score(self):
        self.client.force_authenticate(self.user)
        self.client.post('/api/reports/', {'latitude': 12.93, 'longitude': 77.62, **GOOD}, format='json')
        res = self.client.post('/api/reports/', {'latitude': 12.93, 'longitude': 77.62, **GOOD}, format='json')
        self.assertTrue(res.data['flagged'])
        self.area.refresh_from_db()
        self.assertEqual(self.area.report_count, 1)

    def test_authority_permissions_and_resolve(self):
        self.client.force_authenticate(self.user)
        self.assertEqual(self.client.get('/api/authority/summary/').status_code, 403)
        self.make(street_lighting=2)
        self.client.force_authenticate(self.admin)
        res = self.client.get('/api/authority/summary/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['top_issues'][0]['parameter'], 'street_lighting')
        r = self.client.post('/api/authority/resolve/', {'area': self.area.id, 'parameter': 'street_lighting'}, format='json')
        self.assertEqual(r.data['resolved_reports'], 1)
        self.assertEqual(self.client.get('/api/authority/summary/').data['top_issues'], [])
