"""Start the upstream service without its environment-dumping launcher or own scheduler."""
import init_sys
init_sys.init()
import uvicorn
from web import app
from paian_collector.api import router

app.include_router(router)
uvicorn.run(app, host="0.0.0.0", port=8001)
