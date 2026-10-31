"""MCP caller for the Research-KB data space token."""
import json, os, sys, subprocess

def get_token():
    return open(os.path.expanduser('~/.zrb-secrets/research-mcp-token.txt')).read().strip()

def mcp_session():
    token = get_token()
    r = subprocess.run(['curl','-s','-D','-','-o','/dev/null','-X','POST','https://data.cstcloud.cn/mcp',
        '-H',f'Authorization: Bearer {token}','-H','Content-Type: application/json',
        '-H','Accept: application/json, text/event-stream',
        '-d','{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"zrb-p0","version":"0.1"}}}'],
        capture_output=True, text=True, timeout=60)
    sid = None
    for line in r.stdout.splitlines():
        if line.lower().startswith('mcp-session-id:'):
            sid = line.split(':',1)[1].strip()
    return sid

def call(tool, args, sid=None):
    token = get_token()
    if sid is None:
        sid = mcp_session()
        subprocess.run(['curl','-s','-X','POST','https://data.cstcloud.cn/mcp',
            '-H',f'Authorization: Bearer {token}','-H','Content-Type: application/json',
            '-H','Accept: application/json, text/event-stream',
            '-H',f'Mcp-Session-Id: {sid}',
            '-d','{"jsonrpc":"2.0","method":"notifications/initialized"}'],
            capture_output=True, text=True, timeout=60)
    body = json.dumps({"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":tool,"arguments":args}})
    r = subprocess.run(['curl','-s','-X','POST','https://data.cstcloud.cn/mcp',
        '-H',f'Authorization: Bearer {token}','-H','Content-Type: application/json',
        '-H','Accept: application/json, text/event-stream',
        '-H',f'Mcp-Session-Id: {sid}','-d',body],
        capture_output=True, text=True, timeout=120)
    raw = r.stdout
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith('data:'): line = line[5:].strip()
        if line.startswith('{'):
            try: d = json.loads(line)
            except: continue
            if 'result' in d or 'error' in d:
                return d
    return {'parse_error': raw[:500]}

if __name__ == '__main__':
    tool = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    out = call(tool, args)
    print(json.dumps(out, ensure_ascii=False, indent=1)[:200000])
