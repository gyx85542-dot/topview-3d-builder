import hashlib
import io
import json
import re
import os
import tempfile
from pathlib import Path

from PIL import Image
from aiohttp import web
import folder_paths
from server import PromptServer

ROOT = Path(__file__).resolve().parent
MAX_STATE = 8 * 1024 * 1024
MAX_IMAGE = 32 * 1024 * 1024


def storage():
    root = Path(folder_paths.get_input_directory()) / "topview3d"
    root.mkdir(parents=True, exist_ok=True)
    return root


def safe_file(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise web.HTTPNotFound()
    return path


def parse_state(raw):
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_STATE:
        raise ValueError("Scene data is too large")
    state = json.loads(raw)
    if not isinstance(state, dict) or state.get("version") != 1:
        raise ValueError("Unsupported Topview scene version")
    doc = state.get("document")
    if not isinstance(doc, dict) or doc.get("type") != "biz/scene3d-director-document":
        raise ValueError("Invalid Topview scene document")
    content = doc.get("content")
    if not isinstance(content, dict) or not isinstance(content.get("nodes"), list):
        raise ValueError("Invalid scene nodes")
    return state


def scene_signature(state):
    # Render IDs are immutable, and must correspond to this exact editable state.
    clean = {k: v for k, v in state.items() if k != "render_id"}
    return json.dumps(clean, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def render_files(render_id):
    if not isinstance(render_id, str) or not re.fullmatch(r"[a-f0-9]{64}", render_id):
        raise ValueError("No saved preview is available. Open 3D Builder and select Save and Exit.")
    base = storage() / render_id
    return base.with_suffix(".png"), base.with_suffix(".json")


def atomic_write(path, data):
    if path.is_file():
        return
    descriptor, name = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


class Topview3DScene:
    CATEGORY = "Topview"
    RETURN_TYPES = ()
    FUNCTION = "execute"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    def execute(self):
        # The launcher stores editable scene data in workflow node properties.
        # Exported media is consumed through native LoadImage / LoadVideo nodes.
        return ()


def register_routes():
    routes = PromptServer.instance.routes

    @routes.get("/topview3d/editor/{file:.*}")
    async def editor(request):
        return web.FileResponse(safe_file(ROOT / "editor", request.match_info["file"] or "index.html"))

    @routes.get("/topview3d/assets/{file:.*}")
    async def assets(request):
        return web.FileResponse(safe_file(ROOT / "assets", request.match_info["file"]))

    @routes.get("/topview3d/render/{render_id}")
    async def preview(request):
        try:
            png, _ = render_files(request.match_info["render_id"])
            if not png.is_file():
                raise web.HTTPNotFound()
            return web.FileResponse(png)
        except ValueError:
            raise web.HTTPNotFound()

    @routes.post("/topview3d/render")
    async def upload(request):
        try:
            reader = await request.multipart()
            parts = {}
            async for part in reader:
                if part.name not in {"state", "image"} or part.name in parts:
                    raise ValueError("Unexpected upload field")
                data = bytearray()
                limit = MAX_STATE if part.name == "state" else MAX_IMAGE
                while chunk := await part.read_chunk():
                    data.extend(chunk)
                    if len(data) > limit:
                        raise ValueError("Upload exceeds size limit")
                parts[part.name] = bytes(data)
            state = parse_state(parts["state"].decode("utf-8"))
            raw_image = parts["image"]
            with Image.open(io.BytesIO(raw_image)) as image:
                if image.format != "PNG" or not (1 <= image.width <= 4096 and 1 <= image.height <= 4096):
                    raise ValueError("Expected a PNG image up to 4096 x 4096")
                if (image.width, image.height) != (state.get("width"), state.get("height")):
                    raise ValueError("Image dimensions do not match scene settings")
                image.verify()
            signature = scene_signature(state)
            render_id = hashlib.sha256(signature.encode("utf-8") + raw_image).hexdigest()
            png, metadata = render_files(render_id)
            # Unique content-addressed names prevent old queued prompts reading new frames.
            atomic_write(png, raw_image)
            atomic_write(metadata, signature.encode("utf-8"))
            return web.json_response({"render_id": render_id})
        except (ValueError, KeyError, UnicodeError, OSError) as error:
            return web.json_response({"error": str(error)}, status=400)
