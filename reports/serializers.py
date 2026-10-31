from django.contrib.auth.models import User
from rest_framework import serializers

from .models import PARAMS, AreaScore, Report


class ReportSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True)
    area_name = serializers.CharField(source='area.name', read_only=True, default=None)
    photo_url = serializers.SerializerMethodField()

    class Meta:
        model = Report
        fields = ['id', 'username', 'area', 'area_name', 'latitude', 'longitude', 'street_name',
                  'photo', 'photo_url', *PARAMS, 'comment', 'is_flagged', 'is_resolved', 'created_at']
        read_only_fields = ['id', 'area', 'is_flagged', 'is_resolved', 'created_at']
        extra_kwargs = {'photo': {'write_only': True, 'required': False}}

    def get_photo_url(self, obj):
        return obj.photo.url if obj.photo else None

    def validate_latitude(self, v):
        if not -90 <= v <= 90:
            raise serializers.ValidationError('Latitude out of range.')
        return v

    def validate_longitude(self, v):
        if not -180 <= v <= 180:
            raise serializers.ValidationError('Longitude out of range.')
        return v


class AreaScoreSerializer(serializers.ModelSerializer):
    class Meta:
        model = AreaScore
        fields = ['id', 'name', 'center_lat', 'center_lng', 'radius_m',
                  *[f'avg_{p}' for p in PARAMS], 'composite_score', 'report_count', 'last_updated']


class RegisterSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ['username', 'password']
        extra_kwargs = {'password': {'write_only': True, 'min_length': 6}}

    def create(self, data):
        return User.objects.create_user(**data)
