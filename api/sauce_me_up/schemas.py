"""Declared response contract for the API.

The wire format uses camelCase (firstImageUrl, pageCount) to match the
frontend's Sauce type; the Python side uses snake_case field names
with aliases. FastAPI validates every response against these models,
so contract drift fails loudly server-side instead of silently in the UI.
"""

from pydantic import BaseModel, ConfigDict, Field


class SauceOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: int
    title: str
    url: str
    first_image_url: str | None = Field(default=None, alias="firstImageUrl")
    page_count: int | None = Field(default=None, alias="pageCount")


class BatchOut(BaseModel):
    items: list[SauceOut]
    errors: int


class PagesOut(BaseModel):
    id: int
    count: int
    images: list[str]
