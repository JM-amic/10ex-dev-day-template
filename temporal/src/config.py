from __future__ import annotations
from pydantic import Field
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    temporal_address: str = Field("temporal:7233", env="TEMPORAL_ADDRESS")
    temporal_namespace: str = Field("default", env="TEMPORAL_NAMESPACE")
    temporal_task_queue: str = Field("main", env="TEMPORAL_TASK_QUEUE")
    supabase_url: str = Field("http://host.docker.internal:54321", env="SUPABASE_URL")
    supabase_service_role_key: str = Field("dev-service-role-key", env="SUPABASE_SERVICE_ROLE_KEY")
    azure_openai_endpoint: str = Field("", env="AZURE_OPENAI_ENDPOINT")
    azure_openai_api_version: str = Field("2025-04-01-preview", env="AZURE_OPENAI_API_VERSION")
    azure_openai_model: str = Field("", env="AZURE_OPENAI_MODEL")
    azure_openai_api_key: str = Field("", env="AZURE_OPENAI_API_KEY")

    class Config:
        case_sensitive = False

settings = Settings()
