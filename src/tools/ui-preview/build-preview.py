import re
from pathlib import Path

def generate_preview():
    root = Path(__file__).resolve().parent.parent.parent
    markup_file = root / "src" / "modules" / "sidebarMarkup.ts"
    css_file = root / "addon" / "content" / "dashboard.css"
    settings_xhtml_file = root / "addon" / "content" / "settings.xhtml"
    settings_css_file = root / "addon" / "content" / "settings.css"
    out_file = root / "tools" / "ui-preview" / "sidebar-preview.html"

    # 读取 markup
    markup_raw = markup_file.read_text(encoding="utf-8")
    m = re.search(r"export\s+const\s+sidebarMarkup\s*=\s*`([\s\S]*?)`;", markup_raw)
    if not m:
        raise ValueError("Cannot extract markup from sidebarMarkup.ts")
    markup_content = m.group(1).strip()

    # 读取 css
    css_content = css_file.read_text(encoding="utf-8")
    settings_css_content = settings_css_file.read_text(encoding="utf-8")

    # 读取并转换 settings xhtml -> html 片段
    # 注意：settings-app 内部有嵌套 div（引擎卡片等），不能用非贪婪匹配到第一个 </html:div>
    settings_raw = settings_xhtml_file.read_text(encoding="utf-8")
    m_settings = re.search(r"<html:div class=\"settings-app\">([\s\S]*)</html:div>\s*</window>", settings_raw)
    settings_html = ""
    if m_settings:
        inner = m_settings.group(1)
        # 移除 html: 命名空间前缀（开闭标签都要保留斜杠：</html:h1> → </h1>）
        settings_html = re.sub(r"<(\/?)html:", r"<\1", inner)
        settings_html = f'<div class="settings-app">{settings_html}</div>'

    # 构造假数据项目 HTML
    items_html = """
      <!-- 假数据 1: 待解析 + 超长标题 -->
      <div class="zrb-item">
        <div class="zrb-paper-info">
          <div class="zrb-paper-title" title="Attention Is All You Need: Discovering Deep Multimodal Transformer Architectures for Ultra Large-Scale Cross-Lingual Knowledge Representation">Attention Is All You Need: Discovering Deep Multimodal Transformer Architectures for Ultra Large-Scale Cross-Lingual Knowledge Representation</div>
          <div class="zrb-paper-meta">2017 · ATTR1001 · 10.48550/arXiv.1706.03762</div>
        </div>
        <span class="zrb-status zrb-status-wait">待解析</span>
        <span class="zrb-status zrb-status-neutral">未同步</span>
        <button class="zrb-locate" title="解析这篇文献">↻</button>
      </div>

      <!-- 假数据 2: 已解析 + 已同步 -->
      <div class="zrb-item">
        <div class="zrb-paper-info">
          <div class="zrb-paper-title" title="Deep Residual Learning for Image Recognition">Deep Residual Learning for Image Recognition</div>
          <div class="zrb-paper-meta">2016 · HE1002 · 10.1109/CVPR.2016.90</div>
        </div>
        <span class="zrb-status zrb-status-ok">已解析</span>
        <span class="zrb-status zrb-status-info">已同步 ✓</span>
        <button class="zrb-locate" title="在 Zotero 中打开">↗</button>
      </div>

      <!-- 假数据 3: 解析中 -->
      <div class="zrb-item">
        <div class="zrb-paper-info">
          <div class="zrb-paper-title" title="BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding">BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding</div>
          <div class="zrb-paper-meta">2018 · DEV1003 · 10.18653/v1/N19-1423</div>
        </div>
        <span class="zrb-status zrb-status-info">解析中</span>
        <span class="zrb-status zrb-status-neutral">未同步</span>
        <button class="zrb-locate" title="在 Zotero 中打开">↗</button>
      </div>

      <!-- 假数据 4: 解析失败 + 超长错误信息 (验证 overflow-wrap: anywhere) -->
      <div class="zrb-item">
        <div class="zrb-paper-info">
          <div class="zrb-paper-title" title="Quantum Computational Supremacy Using a High-Dimensional Programmable Superconducting Processor">Quantum Computational Supremacy Using a High-Dimensional Programmable Superconducting Processor</div>
          <div class="zrb-paper-meta">2019 · ARU1004 · 10.1038/s41586-019-1666-5</div>
        </div>
        <span class="zrb-status zrb-status-error">解析失败</span>
        <span class="zrb-status zrb-status-neutral">未同步</span>
        <button class="zrb-locate" title="解析这篇文献">↻</button>
        <div class="zrb-error-detail">MinerU API Error 504: Gateway Timeout after 60000ms. Detail: Failed to parse vector graphics stream at page 14; memory limit exceeded (1024MB allocated). Please retry or split the PDF.</div>
      </div>

      <!-- 假数据 5: 已解析 + 待同步 -->
      <div class="zrb-item">
        <div class="zrb-paper-info">
          <div class="zrb-paper-title" title="Generative Adversarial Nets">Generative Adversarial Nets</div>
          <div class="zrb-paper-meta">2014 · GOOD1005 · 10.1145/3422622</div>
        </div>
        <span class="zrb-status zrb-status-ok">已解析</span>
        <span class="zrb-status zrb-status-wait">待同步</span>
        <button class="zrb-locate" title="在 Zotero 中打开">↗</button>
      </div>

      <!-- 假数据 6: 已解析 + 知识库已验证 -->
      <div class="zrb-item">
        <div class="zrb-paper-info">
          <div class="zrb-paper-title" title="Mastering the Game of Go with Deep Neural Networks and Tree Search">Mastering the Game of Go with Deep Neural Networks and Tree Search</div>
          <div class="zrb-paper-meta">2016 · SILV1006 · 10.1038/nature16961</div>
        </div>
        <span class="zrb-status zrb-status-ok">已解析</span>
        <span class="zrb-status zrb-status-info">知识库已验证</span>
        <button class="zrb-locate" title="在 Zotero 中打开">↗</button>
      </div>

      <!-- 假数据 7: 同步失败 + 错误详情 -->
      <div class="zrb-item">
        <div class="zrb-paper-info">
          <div class="zrb-paper-title" title="Language Models are Few-Shot Learners">Language Models are Few-Shot Learners</div>
          <div class="zrb-paper-meta">2020 · BROW1007 · 10.48550/arXiv.2005.14165</div>
        </div>
        <span class="zrb-status zrb-status-ok">已解析</span>
        <span class="zrb-status zrb-status-error">同步失败</span>
        <button class="zrb-locate" title="重试同步">↻</button>
        <div class="zrb-error-detail">S3 Capsule Error 403: SignatureDoesNotMatch. AccessKey Secret is invalid or expired for bucket 'capsule-prod-bj'.</div>
      </div>
    """

    # 填充真实体量统计数字（如 383，验证在 300px 下无裁切）
    populated_markup = markup_content
    populated_markup = populated_markup.replace('id="zrb-total">—', 'id="zrb-total">383')
    populated_markup = populated_markup.replace('id="zrb-parsed">—', 'id="zrb-parsed">272')
    populated_markup = populated_markup.replace('id="zrb-synced">—', 'id="zrb-synced">156')
    populated_markup = populated_markup.replace('id="zrb-pending">—', 'id="zrb-pending">111')
    populated_markup = populated_markup.replace('id="zrb-parsed-note">本地全文', 'id="zrb-parsed-note">解析覆盖率 71%')
    populated_markup = populated_markup.replace('id="zrb-synced-note">数据胶囊', 'id="zrb-synced-note">同步覆盖率 41%')
    populated_markup = populated_markup.replace('id="zrb-flow-total">—', 'id="zrb-flow-total">383 个附件')
    populated_markup = populated_markup.replace('id="zrb-flow-parsed">—', 'id="zrb-flow-parsed">272 篇全文就绪')
    populated_markup = populated_markup.replace('id="zrb-flow-synced">—', 'id="zrb-flow-synced">156 篇已校验上传')
    populated_markup = populated_markup.replace('id="zrb-flow-parse"></div>', 'id="zrb-flow-parse" style="width: 71%;"></div>')
    populated_markup = populated_markup.replace('id="zrb-flow-sync"></div>', 'id="zrb-flow-sync" style="width: 41%;"></div>')
    populated_markup = populated_markup.replace('id="zrb-count-all">0', 'id="zrb-count-all">383')
    populated_markup = populated_markup.replace('id="zrb-count-pending">0', 'id="zrb-count-pending">111')
    populated_markup = populated_markup.replace('id="zrb-count-parsed">0', 'id="zrb-count-parsed">272')
    populated_markup = populated_markup.replace('id="zrb-count-synced">0', 'id="zrb-count-synced">156')
    populated_markup = populated_markup.replace('id="zrb-count-failed">0', 'id="zrb-count-failed">4')
    populated_markup = populated_markup.replace('id="zrb-list-count"></span>', 'id="zrb-list-count">显示 7 / 383 篇</span>')
    populated_markup = populated_markup.replace('id="zrb-footer-text">本地账本', 'id="zrb-footer-text">本地账本 · 383 条记录 · 更新于 18:20')
    populated_markup = populated_markup.replace('id="zrb-parse" class="zrb-button zrb-primary">▷ 解析', 'id="zrb-parse" class="zrb-button zrb-primary">▷ 解析待处理文献（111）')
    populated_markup = populated_markup.replace('<div id="zrb-items" class="zrb-items"></div>', f'<div id="zrb-items" class="zrb-items">{items_html}</div>')

    # 生成包含控制栏和响应式多宽度的页面
    html_page = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ZoteroResearchBridge (ZRB) · 侧栏与设置 UI 预览</title>
  <style>
    /* 外围预览容器样式，不影响内部隔离 */
    body {{
      margin: 0;
      padding: 0;
      background: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #e2e8f0;
      min-height: 100vh;
    }}
    .preview-navbar {{
      position: sticky;
      top: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding: 10px 20px;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }}
    .preview-title {{
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }}
    .preview-title span {{
      font-size: 11px;
      color: #94a3b8;
      font-weight: normal;
    }}
    .preview-controls {{
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }}
    .preview-btn {{
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 6px;
      border: 1px solid #475569;
      background: #334155;
      color: #f1f5f9;
      cursor: pointer;
      transition: all 0.15s ease;
    }}
    .preview-btn:hover {{
      background: #475569;
      border-color: #64748b;
    }}
    .preview-btn.active {{
      background: #2563eb;
      border-color: #3b82f6;
      color: #ffffff;
    }}
    .preview-stage {{
      padding: 24px 20px;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      gap: 24px;
      overflow-x: auto;
    }}
    .preview-column {{
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
    }}
    .preview-col-header {{
      font-size: 12px;
      color: #94a3b8;
      font-weight: 500;
      display: flex;
      justify-content: space-between;
      padding: 0 4px;
    }}
    .preview-device {{
      border: 1px solid #334155;
      border-radius: 8px;
      background: var(--zrb-bg, #f8fafc);
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      resize: horizontal;
      overflow: auto;
    }}

    /* 独立设置容器模拟 */
    .preview-settings-window {{
      width: 680px;
      height: 700px;
      border: 1px solid #334155;
      border-radius: 8px;
      background: var(--bg, #f8fafc);
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }}

    /* 内嵌 dashboard.css */
{css_content}

    /* 内嵌 settings.css */
{settings_css_content}
  </style>
</head>
<body>
  <div class="preview-navbar">
    <div class="preview-title">
      <strong>ZRB 侧栏工作台与设置 UI 预览</strong>
      <span>基准字号 13px · 统计数值 24px · 最小字号 11px</span>
    </div>
    <div class="preview-controls">
      <button class="preview-btn active" onclick="setViewMode('all')">全视口对比 (260/300/360/500px)</button>
      <button class="preview-btn" onclick="setViewMode('260')">极窄 260px</button>
      <button class="preview-btn" onclick="setViewMode('300')">典型 300px (无裁切)</button>
      <button class="preview-btn" onclick="setViewMode('360')">标准 360px</button>
      <button class="preview-btn" onclick="setViewMode('500')">宽屏 500px (4列)</button>
      <button class="preview-btn" onclick="setViewMode('settings')">⚙ 设置窗口预览</button>
      <button class="preview-btn" onclick="toggleTheme()">🌓 切换亮色/深色主题</button>
    </div>
  </div>

  <div class="preview-stage" id="stage">
    <!-- 260px 极窄视口 -->
    <div class="preview-column" id="col-260">
      <div class="preview-col-header">
        <span>极窄侧栏 (260px)</span>
        <span>最小安全宽度</span>
      </div>
      <div class="preview-device zrb-sidebar-body" style="width: 260px;">
        {populated_markup}
      </div>
    </div>

    <!-- 300px 典型窄侧栏 (重点验证数字 383 完整显示) -->
    <div class="preview-column" id="col-300">
      <div class="preview-col-header">
        <span>典型窄侧栏 (300px)</span>
        <span>数字 383 无裁切</span>
      </div>
      <div class="preview-device zrb-sidebar-body" style="width: 300px;">
        {populated_markup}
      </div>
    </div>

    <!-- 360px 标准视口 -->
    <div class="preview-column" id="col-360">
      <div class="preview-col-header">
        <span>标准侧栏 (360px)</span>
        <span>常见使用宽度</span>
      </div>
      <div class="preview-device zrb-sidebar-body" style="width: 360px;">
        {populated_markup}
      </div>
    </div>

    <!-- 500px 宽屏视口 -->
    <div class="preview-column" id="col-500">
      <div class="preview-col-header">
        <span>宽屏侧栏 (500px)</span>
        <span>统计卡 4 列横排</span>
      </div>
      <div class="preview-device zrb-sidebar-body" style="width: 500px;">
        {populated_markup}
      </div>
    </div>

    <!-- 设置窗口独立视口 -->
    <div class="preview-column" id="col-settings" style="display: none;">
      <div class="preview-col-header">
        <span>设置窗口 (Settings Dialog)</span>
        <span>正文 13px · label 12.5px · 输入框 32px</span>
      </div>
      <div class="preview-settings-window">
        {settings_html}
      </div>
    </div>
  </div>

  <script>
    function setViewMode(mode) {{
      document.querySelectorAll('.preview-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      const c260 = document.getElementById('col-260');
      const c300 = document.getElementById('col-300');
      const c360 = document.getElementById('col-360');
      const c500 = document.getElementById('col-500');
      const cSettings = document.getElementById('col-settings');

      if (mode === 'all') {{
        c260.style.display = 'flex';
        c300.style.display = 'flex';
        c360.style.display = 'flex';
        c500.style.display = 'flex';
        cSettings.style.display = 'none';
      }} else if (mode === '260') {{
        c260.style.display = 'flex';
        c300.style.display = 'none';
        c360.style.display = 'none';
        c500.style.display = 'none';
        cSettings.style.display = 'none';
      }} else if (mode === '300') {{
        c260.style.display = 'none';
        c300.style.display = 'flex';
        c360.style.display = 'none';
        c500.style.display = 'none';
        cSettings.style.display = 'none';
      }} else if (mode === '360') {{
        c260.style.display = 'none';
        c300.style.display = 'none';
        c360.style.display = 'flex';
        c500.style.display = 'none';
        cSettings.style.display = 'none';
      }} else if (mode === '500') {{
        c260.style.display = 'none';
        c300.style.display = 'none';
        c360.style.display = 'none';
        c500.style.display = 'flex';
        cSettings.style.display = 'none';
      }} else if (mode === 'settings') {{
        c260.style.display = 'none';
        c300.style.display = 'none';
        c360.style.display = 'none';
        c500.style.display = 'none';
        cSettings.style.display = 'flex';
      }}
    }}

    let isDark = false;
    function toggleTheme() {{
      isDark = !isDark;
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
      document.querySelectorAll('.preview-device, .preview-settings-window').forEach(dev => {{
        dev.style.colorScheme = isDark ? 'dark' : 'light';
      }});
    }}
  </script>
</body>
</html>
"""

    out_file.write_text(html_page, encoding="utf-8")
    print(f"Generated preview page at: {out_file}")

if __name__ == "__main__":
    generate_preview()