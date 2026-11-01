# -*- coding: utf-8 -*-
"""修复 parser.ts 中 buildMultipart 的换行转义（真实换行 → \\r\\n 转义序列）。"""
import io
import sys

BASE = r"<repo>\src"
p = BASE + r"\src\modules\parser.ts"
s = io.open(p, encoding="utf-8").read()

start = s.find("// 插件沙箱无 FormData")
end_marker = "return { body, contentType: `multipart/form-data; boundary=${boundary}` };\n}"
end = s.find(end_marker)
assert start != -1 and end != -1, f"markers not found: {start}, {end}"
end += len(end_marker)

CRLF = "\\" + "r" + "\\" + "n"  # TS 源码里的字面 \r\n 转义序列

correct = (
    "// 插件沙箱无 FormData 全局 → 手工构建 multipart/form-data 字节体\n"
    "function buildMultipart(\n"
    "  fields: Record<string, string>,\n"
    "  file?: { field: string; filename: string; bytes: Uint8Array; contentType?: string },\n"
    "): { body: Uint8Array; contentType: string } {\n"
    '  const boundary = "----ZRBForm" + Math.random().toString(16).slice(2);\n'
    "  const enc = new TextEncoder();\n"
    "  const parts: Uint8Array[] = [];\n"
    "  for (const [k, v] of Object.entries(fields)) {\n"
    '    parts.push(enc.encode(`--${boundary}' + CRLF + 'Content-Disposition: form-data; name="${k}"' + CRLF + CRLF + '${v}' + CRLF + '`));\n'
    "  }\n"
    "  if (file) {\n"
    "    parts.push(enc.encode(\n"
    '      `--${boundary}' + CRLF + 'Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"' + CRLF + 'Content-Type: ${file.contentType || "application/octet-stream"}' + CRLF + CRLF + '`,\n'
    "    ));\n"
    "    parts.push(file.bytes);\n"
    "    parts.push(enc.encode(`" + CRLF + "`));\n"
    "  }\n"
    "  parts.push(enc.encode(`--${boundary}--" + CRLF + "`));\n"
    "  const total = parts.reduce((a, p) => a + p.length, 0);\n"
    "  const body = new Uint8Array(total);\n"
    "  let off = 0;\n"
    "  for (const p of parts) { body.set(p, off); off += p.length; }\n"
    "  return { body, contentType: `multipart/form-data; boundary=${boundary}` };\n"
    "}"
)

s = s[:start] + correct + s[end:]
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("buildMultipart escapes fixed")
