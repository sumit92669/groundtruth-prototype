from django.urls import path
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from . import views

urlpatterns = [
    path('auth/register/', views.register),
    path('auth/token/', TokenObtainPairView.as_view()),
    path('auth/token/refresh/', TokenRefreshView.as_view()),
    path('me/', views.me),
    path('reports/', views.ReportListCreate.as_view()),
    path('areas/', views.AreaList.as_view()),
    path('areas/<int:pk>/', views.AreaDetail.as_view()),
    path('authority/summary/', views.authority_summary),
    path('authority/resolve/', views.resolve_issue),
    path('official-data/', views.official_data),
]
