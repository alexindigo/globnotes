import os
import secrets
from typing import List, Literal

from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from jose import JWTError

import api_messages
from auth.models import Login, Token
from files import FileServing
from files.models import FileCreateResponse
from global_config import (
    AuthType,
    GlobalConfig,
    GlobalConfigResponseModel,
    SetupRequest,
    SetupStatus,
)
from helpers import hash_password, rewrite_index_html
from logger import logger
from notes.base import BaseNotes
from notes.models import Note, NoteCreate, NoteUpdate, SearchResult

global_config = GlobalConfig()
# Mutable holder so the first-run setup wizard can attach auth at runtime.
auth_state = {"auth": global_config.load_auth()}
note_storage: BaseNotes = global_config.load_note_storage()
file_serving: FileServing = global_config.load_file_serving()


def require_auth(request: Request):
    """Authenticate the request against the current auth state. Also gates
    all data APIs while first-run setup is incomplete, and writes while in
    read-only mode."""
    if global_config.setup_required:
        raise HTTPException(status_code=503, detail="setup_required")
    if (
        global_config.auth_type == AuthType.READ_ONLY
        and request.method != "GET"
    ):
        raise HTTPException(status_code=403, detail="read-only mode")
    current_auth = auth_state["auth"]
    if current_auth is not None:
        token = None
        authorization = request.headers.get("Authorization")
        if authorization and authorization.lower().startswith("bearer "):
            token = authorization[len("bearer ") :]
        if token is None:
            token = request.cookies.get("token")
        try:
            current_auth._validate_token(token)
        except (JWTError, ValueError):
            raise HTTPException(
                status_code=401,
                detail="Invalid authentication credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )


auth_deps = [Depends(require_auth)]
router = APIRouter()
app = FastAPI(
    docs_url=global_config.path_prefix + "/_/api/docs",
    openapi_url=global_config.path_prefix + "/_/api/openapi.json",
)
rewrite_index_html("client/dist/index.html", global_config.path_prefix)

if global_config.setup_required:
    logger.info(
        "First-run setup required. Open the web UI to complete setup."
    )
elif global_config.auth_type == AuthType.NONE:
    logger.warning(
        "globnotes is running with NO authentication. Anyone who can "
        "reach this server can read and modify notes."
    )


# region UI
@router.get("/", include_in_schema=False)
@router.get("/_/login", include_in_schema=False)
@router.get("/_/search", include_in_schema=False)
@router.get("/_/new", include_in_schema=False)
def serve_index():
    with open("client/dist/index.html", "r", encoding="utf-8") as f:
        html = f.read()
    return HTMLResponse(content=html)


# endregion


# region Setup
@router.get("/_/api/setup", response_model=SetupStatus)
def get_setup():
    """Get the first-run setup status."""
    return SetupStatus(setup_required=global_config.setup_required)


@router.post("/_/api/setup", response_model=SetupStatus)
def post_setup(data: SetupRequest):
    """Complete first-run setup: create a password or disable auth."""
    if not global_config.setup_required:
        raise HTTPException(
            status_code=409, detail="Setup has already been completed."
        )
    if data.mode == "none":
        global_config.save_stored_config({"auth_type": AuthType.NONE.value})
        global_config.auth_type = AuthType.NONE
        global_config.setup_required = False
        logger.warning(
            "Authentication disabled via first-run setup. Anyone who can "
            "reach this server can read and modify notes."
        )
    elif data.mode == "read_only":
        global_config.save_stored_config(
            {"auth_type": AuthType.READ_ONLY.value}
        )
        global_config.auth_type = AuthType.READ_ONLY
        global_config.setup_required = False
        logger.info(
            "Read-only mode enabled via first-run setup. Notes can be "
            "browsed and searched but not modified."
        )
    else:
        if not data.username or not data.password:
            raise HTTPException(
                status_code=400,
                detail="Username and password are required.",
            )
        global_config.save_stored_config(
            {
                "auth_type": AuthType.PASSWORD.value,
                "username": data.username.lower(),
                "password_hash": hash_password(data.password),
                "secret_key": secrets.token_hex(32),
            }
        )
        global_config.auth_type = AuthType.PASSWORD
        global_config.setup_required = False
        auth_state["auth"] = global_config.load_auth()
    return SetupStatus(setup_required=global_config.setup_required)


# endregion


# region Auth
if global_config.auth_type not in [AuthType.NONE, AuthType.READ_ONLY]:

    @router.post("/_/api/token", response_model=Token)
    def token(data: Login):
        if auth_state["auth"] is None:
            raise HTTPException(
                status_code=400, detail="Authentication is not enabled."
            )
        try:
            return auth_state["auth"].login(data)
        except ValueError:
            raise HTTPException(
                status_code=401, detail=api_messages.login_failed
            )


@router.get("/_/api/auth-check", dependencies=auth_deps)
def auth_check() -> str:
    """A lightweight endpoint that simply returns 'OK' if the user is
    authenticated."""
    return "OK"


# endregion


# region Notes
# Get Note
@router.get(
    "/_/api/notes/{title:path}",
    dependencies=auth_deps,
    response_model=Note,
)
def get_note(title: str):
    """Get a specific note."""
    try:
        return note_storage.get(title)
    except ValueError:
        raise HTTPException(
            status_code=400, detail=api_messages.invalid_note_title
        )
    except FileNotFoundError:
        raise HTTPException(404, api_messages.note_not_found)



# Create Note
@router.post(
    "/_/api/notes",
    dependencies=auth_deps,
    response_model=Note,
)
def post_note(note: NoteCreate):
    """Create a new note."""
    try:
        return note_storage.create(note)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=api_messages.invalid_note_title,
        )
    except FileExistsError:
        raise HTTPException(
            status_code=409, detail=api_messages.note_exists
        )

# Update Note
@router.patch(
    "/_/api/notes/{title:path}",
    dependencies=auth_deps,
    response_model=Note,
)
def patch_note(title: str, data: NoteUpdate):
    try:
        return note_storage.update(title, data)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=api_messages.invalid_note_title,
        )
    except FileExistsError:
        raise HTTPException(
            status_code=409, detail=api_messages.note_exists
        )
    except FileNotFoundError:
        raise HTTPException(404, api_messages.note_not_found)

# Delete Note
@router.delete(
    "/_/api/notes/{title:path}",
    dependencies=auth_deps,
    response_model=None,
)
def delete_note(title: str):
    try:
        note_storage.delete(title)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=api_messages.invalid_note_title,
        )
    except FileNotFoundError:
        raise HTTPException(404, api_messages.note_not_found)


# endregion


# region Search
@router.get(
    "/_/api/search",
    dependencies=auth_deps,
    response_model=List[SearchResult],
)
def search(
    term: str,
    sort: Literal["score", "title", "lastModified"] = "score",
    order: Literal["asc", "desc"] = "desc",
    limit: int = None,
    nested: bool = True,
):
    """Perform a full text search on all notes. When nested is false, only
    root-level notes are included."""
    if sort == "lastModified":
        sort = "last_modified"
    return note_storage.search(
        term, sort=sort, order=order, limit=limit, nested=nested
    )


@router.get(
    "/_/api/tags",
    dependencies=auth_deps,
    response_model=List[str],
)
def get_tags():
    """Get a list of all indexed tags."""
    return note_storage.get_tags()


@router.get(
    "/_/api/note-index",
    dependencies=auth_deps,
    response_model=List[str],
)
def get_note_index():
    """Get a list of all note titles. Used by the client to resolve
    wiki-links."""
    return note_storage.get_titles()


# endregion


# region Config
@router.get("/_/api/config", response_model=GlobalConfigResponseModel)
def get_config():
    """Retrieve server-side config required for the UI."""
    return GlobalConfigResponseModel(
        setup_required=global_config.setup_required,
        auth_type=global_config.auth_type,
        quick_access_hide=global_config.quick_access_hide,
        quick_access_title=global_config.quick_access_title,
        quick_access_term=global_config.quick_access_term,
        quick_access_sort=global_config.quick_access_sort,
        quick_access_limit=global_config.quick_access_limit,
    )


# endregion


# region Files
# Get File (direct API access, e.g. raw markdown for agents; note-relative
# vault files are served by the root catch-all)
@router.get(
    "/_/api/files/{path:path}",
    dependencies=auth_deps,
)
def get_file(path: str):
    """Download a file from anywhere in the notes tree."""
    try:
        return file_serving.get(path)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=api_messages.invalid_file_path,
        )
    except FileNotFoundError:
        raise HTTPException(
            status_code=404, detail=api_messages.file_not_found
        )



# Upload File
@router.post(
    "/_/api/files",
    dependencies=auth_deps,
    response_model=FileCreateResponse,
)
def post_file(file: UploadFile, directory: str = Form("")):
    """Upload a file into the given directory (relative to the notes
    root)."""
    try:
        return file_serving.create(directory, file)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=api_messages.invalid_file_name,
        )


# endregion


# region Healthcheck
@router.get("/_/api/health")
def healthcheck() -> str:
    """A lightweight endpoint that simply returns 'OK' to indicate the server
    is running."""
    return "OK"


# endregion

app.include_router(router, prefix=global_config.path_prefix)
app.mount(
    global_config.path_prefix + "/_",
    StaticFiles(directory="client/dist"),
    name="dist",
)


# region Catch-all
# Vault files and note pages live in the root URL space. Anything not
# claimed above (API, app pages, built assets) lands here.
catchall_router = APIRouter()

MARKDOWN_EXT = ".md"


@catchall_router.get("/{path:path}", include_in_schema=False)
def catch_all(path: str, request: Request):
    segments = path.split("/")
    # Machinery and hidden paths are never served from the vault space.
    if segments[0] == "_" or any(s.startswith(".") for s in segments):
        raise HTTPException(status_code=404)
    _, ext = os.path.splitext(path)
    if path and ext and ext.lower() != MARKDOWN_EXT:
        # Looks like a file: serve it if it exists (a real 404 keeps
        # broken-image behavior honest). A note page still wins for
        # dotted titles (e.g. a note named "a/v2.1").
        try:
            require_auth(request)
            return file_serving.get(path)
        except FileNotFoundError:
            if not os.path.isfile(
                os.path.join(file_serving.storage_path, path + MARKDOWN_EXT)
            ):
                raise HTTPException(404, api_messages.file_not_found)
        except ValueError:
            raise HTTPException(400, api_messages.invalid_file_path)
    # Everything else is a note page (the client 404s unknown titles).
    return serve_index()


# endregion

app.include_router(catchall_router, prefix=global_config.path_prefix)
