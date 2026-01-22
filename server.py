#!/usr/bin/env python3
"""Simple development server for the CA RTS game."""

import http.server
import socketserver

PORT = 8080

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS for local development
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Serving at http://localhost:{PORT}")
        httpd.serve_forever()
