"""Direct HTTP test headers; no production configuration or credentials."""
def json_headers(**extra):
    return {"Content-Type":"application/json", **extra}
