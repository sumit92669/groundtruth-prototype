from django.contrib import admin

from .models import AreaScore, Report
from .services import recompute_area


@admin.register(Report)
class ReportAdmin(admin.ModelAdmin):
    list_display = ('street_name', 'area', 'user', 'safety', 'cleanliness', 'is_flagged', 'flag_reason', 'is_resolved', 'created_at')
    list_filter = ('is_flagged', 'is_resolved', 'area')
    search_fields = ('street_name', 'comment', 'user__username')
    actions = ['flag', 'unflag']

    @admin.action(description='Flag selected reports')
    def flag(self, request, qs):
        areas = {r.area for r in qs if r.area}
        qs.update(is_flagged=True, flag_reason='manual')
        [recompute_area(a) for a in areas]

    @admin.action(description='Unflag selected reports')
    def unflag(self, request, qs):
        areas = {r.area for r in qs if r.area}
        qs.update(is_flagged=False, flag_reason='')
        [recompute_area(a) for a in areas]


@admin.register(AreaScore)
class AreaScoreAdmin(admin.ModelAdmin):
    list_display = ('name', 'composite_score', 'report_count', 'last_updated')
