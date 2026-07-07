"""
Deterministic stand-in for the Azure OpenAI Responses API, used only by the
E2E stack (docker-compose.e2e.yml). Mirrors the response shape that
temporal/src/llm_client.py:call_azure_responses parses, so the real worker
code runs unmodified against it -- no Azure credentials or network egress
needed for E2E.

Behavior is driven by markers inside the submitted meeting-notes text so
Playwright tests can select a scenario deterministically:
  - "__E2E_FAIL__"        -> HTTP 500 (simulates a model call failure)
  - "__E2E_ZERO_ITEMS__"  -> 200 with an empty items list
  - anything else         -> 200 with two canned action items
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

DEFAULT_ITEMS = [
    {"description": "Follow up on Q3 budget numbers", "owner": "Alice", "due_date": "2026-08-01"},
    {"description": "Send meeting recap to the team", "owner": None, "due_date": None},
]


class Handler(BaseHTTPRequestHandler):
    def _write_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        # Used only as a docker healthcheck target.
        self._write_json(200, {"status": "ok"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw_body = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw_body or b"{}")
        except json.JSONDecodeError:
            body = {}

        input_text = body.get("input", "") or ""

        if "__E2E_FAIL__" in input_text:
            self._write_json(500, {"error": "simulated model failure"})
            return

        items = [] if "__E2E_ZERO_ITEMS__" in input_text else DEFAULT_ITEMS
        self._write_json(
            200,
            {
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {"type": "output_text", "text": json.dumps({"items": items})}
                        ],
                    }
                ]
            },
        )

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - stdlib signature
        print(f"[stub-llm] {self.address_string()} - {format % args}", flush=True)


def main() -> None:
    server = HTTPServer(("0.0.0.0", 9000), Handler)
    print("stub-llm listening on :9000", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
