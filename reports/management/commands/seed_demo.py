"""Create demo users, 6 Bengaluru areas and ~230 realistic reports.  Usage: python manage.py seed_demo"""
import random
from datetime import timedelta

from django.contrib.auth.models import User
from django.core.management.base import BaseCommand
from django.utils import timezone

from reports.models import PARAMS, AreaScore, Report
from reports.services import recompute_area

# name, lat, lng, mean rating per parameter (0-10), streets
AREAS = [
    ('Indiranagar', 12.9784, 77.6408, dict(cleanliness=8, road_condition=7, street_lighting=8, safety=8, waterlogging=7),
     ['100 Feet Road', '12th Main', 'CMH Road', '6th Cross']),
    ('Jayanagar', 12.9250, 77.5938, dict(cleanliness=7.5, road_condition=7, street_lighting=7, safety=7.5, waterlogging=7),
     ['4th Block Main', '9th Main', 'South End Road', '11th Cross']),
    ('Koramangala', 12.9352, 77.6245, dict(cleanliness=7, road_condition=6, street_lighting=7, safety=7, waterlogging=5),
     ['80 Feet Road', '5th Block Main', '17th Cross', 'Sony Signal Road']),
    ('HSR Layout', 12.9116, 77.6389, dict(cleanliness=7.5, road_condition=5.5, street_lighting=3.5, safety=6.5, waterlogging=5.5),
     ['12th Main Road', '27th Cross', 'Sector 2 Main Road', 'Agara Lake Road']),
    ('BTM Layout', 12.9166, 77.6101, dict(cleanliness=4.5, road_condition=4, street_lighting=5, safety=5.5, waterlogging=3),
     ['2nd Stage Market Road', 'Silk Board Service Road', '16th Main', 'Madiwala Lane']),
    ('Whitefield', 12.9698, 77.7500, dict(cleanliness=5, road_condition=3.5, street_lighting=4.5, safety=5, waterlogging=2.5),
     ['ITPL Main Road', 'Kadugodi Road', 'Hope Farm Junction', 'Varthur Road']),
]
COMMENTS = {
    'cleanliness': ('Garbage piling up near the corner for days.', 'Street is swept daily, very clean.'),
    'road_condition': ('Potholes everywhere, dangerous for two-wheelers.', 'Freshly resurfaced road, smooth ride.'),
    'street_lighting': ('Streetlight near the bus stop has been out for 2 weeks.', 'Well lit even late at night.'),
    'safety': ('Feels unsafe after dark, hardly any foot traffic.', 'Felt safe walking here at night.'),
    'waterlogging': ('Knee-deep waterlogging after every rain.', 'Drains work well, no waterlogging.'),
}


class Command(BaseCommand):
    help = 'Seed demo data'

    def handle(self, *args, **opts):
        rnd = random.Random(26)
        Report.objects.all().delete()
        AreaScore.objects.all().delete()
        User.objects.filter(is_superuser=False).delete()
        demo = User.objects.create_user('demo', 'demo@groundtruth.app', 'demo1234')
        if not User.objects.filter(username='admin').exists():
            User.objects.create_superuser('admin', 'admin@groundtruth.app', 'admin1234')
        users = [demo] + [User.objects.create_user(f'citizen{i}', password='x-demo-pass') for i in range(1, 16)]
        now = timezone.now()
        total = 0
        for name, lat, lng, means, streets in AREAS:
            area = AreaScore.objects.create(name=name, center_lat=lat, center_lng=lng, radius_m=1600)
            for i in range(38):
                street = streets[i % len(streets)]
                vals = {p: max(0, min(10, round(rnd.gauss(means[p], 1.6)))) for p in PARAMS}
                worst = min(PARAMS, key=lambda p: vals[p])
                best = max(PARAMS, key=lambda p: vals[p])
                comment = COMMENTS[worst][0] if vals[worst] <= 4 else COMMENTS[best][1]
                r = Report.objects.create(
                    user=rnd.choice(users), area=area, street_name=street, comment=comment,
                    latitude=lat + rnd.uniform(-0.011, 0.011), longitude=lng + rnd.uniform(-0.011, 0.011), **vals)
                Report.objects.filter(pk=r.pk).update(created_at=now - timedelta(days=rnd.uniform(0, 28), hours=rnd.uniform(0, 12)))
                total += 1
        # a few flagged (moderation) and resolved reports so the admin/dashboard have content
        flagged = list(Report.objects.order_by('?')[:4])
        for r in flagged:
            Report.objects.filter(pk=r.pk).update(is_flagged=True, flag_reason='duplicate')
        ids = list(Report.objects.filter(is_flagged=False, area__name='Koramangala', waterlogging__lte=4).values_list('pk', flat=True)[:4])
        Report.objects.filter(pk__in=ids).update(is_resolved=True)
        for area in AreaScore.objects.all():
            recompute_area(area)
        self.stdout.write(self.style.SUCCESS(
            f'Seeded {AreaScore.objects.count()} areas, {total} reports. '
            'Citizen: demo / demo1234   Authority: admin / admin1234'))
