"""Seeds a minimal dataset for the Synclaire integration suite.

Run from hep-unified-backend/hep_backend:  uv run manage.py shell < <this file>
Prints one line: SEED_RESULT=<json>. Every run creates a fresh facility, so runs don't interfere.
"""
import json

from app_backend.models import NurseProfile, PTSNurse
from app_backend.tests.factory import (
    ClassTypeFactory,
    FacilityFactory,
    NurseProfileFactory,
    PatientTrainingSessionFactory,
    PTSLocationFactory,
)
from core.models import Token

facility = FacilityFactory()
me = NurseProfileFactory(facility=facility, account_status=NurseProfile.NurseProfileStatus.ACTIVE)
colleague = NurseProfileFactory(facility=facility, account_status=NurseProfile.NurseProfileStatus.ACTIVE)
outsider = NurseProfileFactory()

def get_or_make(factory, **kw):
    return factory._meta.model.objects.filter(**kw).first() or factory(**kw)


class_type = get_or_make(ClassTypeFactory, name="ANC")
location = get_or_make(PTSLocationFactory, name="Hall")


def make_session(created_by, tagged, **kw):
    s = PatientTrainingSessionFactory(
        created_by=created_by, facility=facility, class_type=class_type, location=location, **kw
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

print(
    "SEED_RESULT="
    + json.dumps(
        {
            "token": Token.objects.create(user=me.user).key,
            "colleague_token": Token.objects.create(user=colleague.user).key,
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
