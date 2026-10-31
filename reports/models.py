"""GroundTruth data model.

Prototype note: locations are plain latitude/longitude floats (SQLite, no GDAL needed).
The design maps 1:1 onto GeoDjango PointField/PostGIS for production.
"""
from django.contrib.auth.models import User
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone

PARAMS = ['cleanliness', 'road_condition', 'street_lighting', 'safety', 'waterlogging']
PARAM_LABELS = {
    'cleanliness': 'Cleanliness', 'road_condition': 'Road condition',
    'street_lighting': 'Street lighting', 'safety': 'Safety', 'waterlogging': 'Waterlogging',
}
rating = lambda: models.IntegerField(validators=[MinValueValidator(0), MaxValueValidator(10)])


class AreaScore(models.Model):
    name = models.CharField(max_length=120, unique=True)
    center_lat = models.FloatField()
    center_lng = models.FloatField()
    radius_m = models.IntegerField(default=1500)
    avg_cleanliness = models.FloatField(default=0)
    avg_road_condition = models.FloatField(default=0)
    avg_street_lighting = models.FloatField(default=0)
    avg_safety = models.FloatField(default=0)
    avg_waterlogging = models.FloatField(default=0)
    composite_score = models.FloatField(default=0)  # 0-100
    report_count = models.IntegerField(default=0)
    last_updated = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.name} ({self.composite_score:.0f}/100)'


class Report(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='reports')
    area = models.ForeignKey(AreaScore, on_delete=models.SET_NULL, null=True, blank=True, related_name='reports')
    latitude = models.FloatField()
    longitude = models.FloatField()
    street_name = models.CharField(max_length=255, blank=True)
    photo = models.ImageField(upload_to='reports/', null=True, blank=True)
    cleanliness = rating()
    road_condition = rating()
    street_lighting = rating()
    safety = rating()
    waterlogging = rating()
    comment = models.TextField(blank=True)
    is_flagged = models.BooleanField(default=False)
    flag_reason = models.CharField(max_length=40, blank=True)
    is_resolved = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.street_name or "Unnamed"} @ {self.created_at:%d %b}'
