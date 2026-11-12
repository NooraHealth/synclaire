"""Seed a minimal dataset for probing /sync/. Run via:
uv run manage.py shell < ../../.sync-probe/seed.py
"""
import datetime
import json

from django.utils import timezone

from app_backend.models import NurseProfile, PTSNurse, PatientTrainingSession
from app_backend.tests.factory import (
    ClassTypeFactory,
    FacilityFactory,
    NurseProfileFactory,
    PatientTrainingSessionFactory,
    PTSLocationFactory,
)
from core.models import Token

facility = FacilityFactory()
me = NurseProfileFactory(
    facility=facility, account_status=NurseProfile.NurseProfileStatus.ACTIVE
)
colleague = NurseProfileFactory(
    facility=facility, account_status=NurseProfile.NurseProfileStatus.ACTIVE
)
outsider = NurseProfileFactory()  # different facility, should never appear

class_type = ClassTypeFactory(name="ANC")
location = PTSLocationFactory(name="Hall")


def make_session(created_by, tagged, **kw):
    s = PatientTrainingSessionFactory(
        created_by=created_by,
        facility=facility,
        class_type=class_type,
        location=location,
        **kw,
    )
    for n in tagged:
        PTSNurse.objects.create(nurse=n, session=s)
    return s


own = make_session(me, [me, colleague])
own2 = make_session(me, [me])
tagged_by_colleague = make_session(colleague, [colleague, me])
not_mine = make_session(colleague, [colleague])
deleted = make_session(me, [me])
deleted.is_deleted = True
deleted.save()

token = Token.objects.create(user=me.user)

print(
    "SEED_RESULT="
    + json.dumps(
        {
            "token": token.key,
            "me": str(me.uuid),
            "colleague": str(colleague.uuid),
            "outsider": str(outsider.uuid),
            "class_type": str(class_type.uuid),
            "sessions": {
                "own": str(own.uuid),
                "own2": str(own2.uuid),
                "tagged_by_colleague": str(tagged_by_colleague.uuid),
                "not_mine": str(not_mine.uuid),
                "deleted": str(deleted.uuid),
            },
        }
    )
)
