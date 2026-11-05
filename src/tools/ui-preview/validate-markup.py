import re
import sys
import xml.dom.minidom
import xml.etree.ElementTree as ET
from pathlib import Path

# 设置控制台 utf-8 输出避免 Windows GBK 报错
if sys.platform.startswith("win"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

def validate():
    root_dir = Path(__file__).resolve().parent.parent.parent
    sidebar_file = root_dir / "src" / "modules" / "sidebarMarkup.ts"
    settings_file = root_dir / "addon" / "content" / "settings.xhtml"

    print(f"[Check 1] Checking sidebarMarkup: {sidebar_file}")
    if not sidebar_file.exists():
        print(f"Error: {sidebar_file} does not exist", file=sys.stderr)
        sys.exit(1)

    content = sidebar_file.read_text(encoding="utf-8")
    
    # 查找 export const sidebarMarkup = `...`;
    match = re.search(r"export\s+const\s+sidebarMarkup\s*=\s*`([\s\S]*?)`;", content)
    if not match:
        print("Error: Could not find export const sidebarMarkup in file", file=sys.stderr)
        sys.exit(1)

    markup = match.group(1).strip()

    # 检查是否包含非法 ${} 表达式
    if "${" in markup:
        print("Error: sidebarMarkup contains template literal interpolation ${}", file=sys.stderr)
        sys.exit(1)

    # 检查 XML 解析
    xml_content = f'<div xmlns="http://www.w3.org/1999/xhtml">{markup}</div>'
    try:
        xml.dom.minidom.parseString(xml_content.encode("utf-8"))
        ET.fromstring(xml_content.encode("utf-8"))
        print("[OK] sidebarMarkup XML parsing passed (minidom & ElementTree).")
    except Exception as e:
        print(f"Error parsing sidebarMarkup as XML: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"[Check 2] Checking settings.xhtml: {settings_file}")
    if not settings_file.exists():
        print(f"Error: {settings_file} does not exist", file=sys.stderr)
        sys.exit(1)

    settings_content = settings_file.read_text(encoding="utf-8")
    try:
        xml.dom.minidom.parseString(settings_content.encode("utf-8"))
        print("[OK] settings.xhtml XML parsing passed (minidom).")
    except Exception as e:
        print(f"Error parsing settings.xhtml as XML: {e}", file=sys.stderr)
        sys.exit(1)

    print("All markup validation checks passed successfully!")

if __name__ == "__main__":
    validate()
