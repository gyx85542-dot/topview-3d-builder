"""Run with ComfyUI's Python: python test_backend.py (no models/server required)."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

from aiohttp import FormData, web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

ROOT = Path(__file__).parent
temporary = tempfile.TemporaryDirectory()
sys.modules['folder_paths'] = types.SimpleNamespace(get_input_directory=lambda: temporary.name)
routes = web.RouteTableDef()
sys.modules['server'] = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes)))
spec = importlib.util.spec_from_file_location('topview_backend', ROOT / 'ComfyUI-Topview3D/backend.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)
backend.register_routes()


def state():
    return {'version': 1, 'document': {'type': 'biz/scene3d-director-document', 'content': {'nodes': []}},
            'fcurves': None, 'width': 64, 'height': 64, 'render_id': ''}


def png():
    output = io.BytesIO()
    Image.new('RGB', (64, 64), (32, 128, 240)).save(output, format='PNG')
    return output.getvalue()


class BackendTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        app = web.Application()
        app.add_routes(routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def upload(self, scene, image=None):
        form = FormData()
        form.add_field('state', json.dumps(scene))
        form.add_field('image', image if image is not None else png(), filename='test.png', content_type='image/png')
        return await self.client.post('/topview3d/render', data=form)

    async def test_scene_and_preview_saved(self):
        scene = state()
        response = await self.upload(scene)
        self.assertEqual(response.status, 200)
        render_id = (await response.json())['render_id']
        _, metadata = backend.render_files(render_id)
        self.assertEqual(json.loads(metadata.read_text('utf-8')), {k: v for k, v in scene.items() if k != 'render_id'})
        preview = await self.client.get('/topview3d/render/' + render_id)
        self.assertEqual(await preview.read(), png())

    async def test_launcher_has_no_ports(self):
        self.assertEqual(backend.Topview3DScene.INPUT_TYPES(), {'required': {}})
        self.assertEqual(backend.Topview3DScene.RETURN_TYPES, ())
        self.assertEqual(backend.Topview3DScene().execute(), ())

    async def test_missing_preview(self):
        response = await self.client.get('/topview3d/render/' + '0' * 64)
        self.assertEqual(response.status, 404)

    async def test_immutable_deduplication(self):
        first = await (await self.upload(state())).json()
        second = await (await self.upload(state())).json()
        self.assertEqual(first, second)
        changed = state()
        changed['frame'] = 1
        third = await (await self.upload(changed)).json()
        self.assertNotEqual(first, third)

    async def test_wrong_dimensions_rejected(self):
        scene = state()
        scene['width'] = 128
        self.assertEqual((await self.upload(scene)).status, 400)

    async def test_invalid_image_rejected(self):
        self.assertEqual((await self.upload(state(), b'not an image')).status, 400)

    async def test_unsupported_scene_rejected(self):
        scene = state()
        scene['version'] = 999
        self.assertEqual((await self.upload(scene)).status, 400)

    async def test_path_boundaries(self):
        with self.assertRaises(web.HTTPNotFound):
            backend.safe_file(ROOT / 'ComfyUI-Topview3D/editor', '../backend.py')
        with self.assertRaises(ValueError):
            backend.render_files('../../secret')
        self.assertEqual((await self.client.get('/topview3d/render/not-a-hash')).status, 404)


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        temporary.cleanup()
