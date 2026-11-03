"""
WSGI config for groundtruth project.

It exposes the WSGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/6.1/howto/deployment/wsgi/
"""

import os
from pathlib import Path

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'groundtruth.settings')

application = get_wsgi_application()

if os.environ.get('VERCEL') == '1':
    from django.conf import settings
    from django.core.management import call_command

    database_path = Path(settings.DATABASES['default']['NAME'])
    if not database_path.exists():
        database_path.parent.mkdir(parents=True, exist_ok=True)
        call_command('migrate', interactive=False, verbosity=0)
        call_command('seed_demo', verbosity=0)
