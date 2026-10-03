from alembic import context
from sqlalchemy import create_engine

from ii_api.config import Settings
from ii_api.models import Base

url = Settings().database_url.get_secret_value()
if not url:
    raise RuntimeError("Set DATABASE_URL before running migrations")
if context.is_offline_mode():
    context.configure(url=url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    with create_engine(url).connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata)
        with context.begin_transaction():
            context.run_migrations()
