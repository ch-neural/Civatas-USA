"""Legacy project management routes.

These routes are kept for backward compatibility but the primary workflow
now uses /api/workspaces endpoints.
"""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..store import list_workspaces

router = APIRouter()


@router.get("")
async def list_projects():
    """List all projects (returns workspaces for backward compat)."""
    workspaces = list_workspaces()
    return {"projects": workspaces}


@router.get("/merged/config")
async def get_merged_config():
    """Get merged config from the default workspace."""
    from ..store import get_merged_config as ws_merged
    # Use the first workspace if available
    workspaces = list_workspaces()
    if not workspaces:
        return JSONResponse(
            status_code=404,
            content={"error": "尚未建立專案，請先在專案管理中建立專案"},
        )
    ws_id = workspaces[0]["id"]
    config = ws_merged(ws_id)
    if config is None:
        return JSONResponse(
            status_code=404,
            content={"error": "尚未上傳統計資料"},
        )
    return config
