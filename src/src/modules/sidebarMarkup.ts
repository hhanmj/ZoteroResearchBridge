export const sidebarMarkup = `
<div id="zrb-app" class="zrb-sidebar-app">
  <header id="zrb-header">
    <div class="zrb-brand">
      <svg class="zrb-logo" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="zrb-logo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3f8fe0"/><stop offset="1" stop-color="#1f5fa8"/></linearGradient></defs><rect x="4" y="4" width="88" height="88" rx="22" fill="url(#zrb-logo-g)"/><path d="M26 62 C26 42 70 42 70 62" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/><path d="M26 62 v8 M70 62 v8" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/><path d="M20 70 h56" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.85"/><circle cx="48" cy="34" r="6" fill="#8fe3c0"/><path d="M48 40 v10" stroke="#8fe3c0" stroke-width="4" stroke-linecap="round"/></svg>
      <div><div class="zrb-title">Research Bridge</div><div class="zrb-subtitle">解析与同步工作台</div></div>
    </div>
    <div class="zrb-header-actions">
      <button id="zrb-refresh" class="zrb-button zrb-icon" title="重新扫描缓存和状态">↻</button>
      <button id="zrb-settings" class="zrb-button zrb-icon" title="独立设置">⚙</button>
    </div>
  </header>
  <main>
    <section class="zrb-intro">
      <div><h1>文献解析</h1><p>让每篇文献的去向清晰可见。</p></div>
      <button id="zrb-parse" class="zrb-button zrb-primary">▷ 解析</button>
    </section>
    <section id="zrb-stats" class="zrb-stats">
      <button class="zrb-stat zrb-stat-total" data-filter="all"><div class="zrb-stat-label">文献总量</div><div class="zrb-stat-value" id="zrb-total">—</div><div class="zrb-stat-note">Zotero 文献库</div></button>
      <button class="zrb-stat zrb-stat-parsed" data-filter="parsed"><div class="zrb-stat-label">✓ 已解析</div><div class="zrb-stat-value" id="zrb-parsed">—</div><div class="zrb-stat-note" id="zrb-parsed-note">本地全文</div></button>
      <button class="zrb-stat zrb-stat-synced" data-filter="synced"><div class="zrb-stat-label">↑ 已同步</div><div class="zrb-stat-value" id="zrb-synced">—</div><div class="zrb-stat-note" id="zrb-synced-note">数据胶囊</div></button>
      <button class="zrb-stat zrb-stat-pending" data-filter="pending"><div class="zrb-stat-label">◷ 待解析</div><div class="zrb-stat-value" id="zrb-pending">—</div><div class="zrb-stat-note">等待处理</div></button>
    </section>
    <section id="zrb-pipeline" class="zrb-pipeline">
      <div class="zrb-pipeline-step"><span class="zrb-step-icon">1</span><div><strong>PDF 文献</strong><span id="zrb-flow-total">—</span></div></div>
      <div class="zrb-pipeline-line"><div id="zrb-flow-parse"></div></div>
      <div class="zrb-pipeline-step"><span class="zrb-step-icon zrb-step-green">2</span><div><strong>解析完成</strong><span id="zrb-flow-parsed">—</span></div></div>
      <div class="zrb-pipeline-line"><div id="zrb-flow-sync"></div></div>
      <div class="zrb-pipeline-step"><span class="zrb-step-icon zrb-step-blue">3</span><div><strong>知识胶囊</strong><span id="zrb-flow-synced">—</span></div></div>
    </section>
    <section id="zrb-task" class="zrb-task" hidden="hidden">
      <div class="zrb-task-head"><div><span id="zrb-task-spinner" class="zrb-spinner"></span><strong id="zrb-task-title">正在处理</strong></div><span id="zrb-task-percent">0%</span></div>
      <div class="zrb-task-detail" id="zrb-task-detail"></div><progress id="zrb-task-progress" value="0" max="100"></progress>
    </section>
    <section class="zrb-workspace">
      <div class="zrb-list-area">
        <div class="zrb-toolbar"><input id="zrb-search" type="search" placeholder="搜索标题、DOI 或附件 Key…" /><select id="zrb-sort"><option value="attention">待处理优先</option><option value="title">按标题</option><option value="recent">最近更新</option><option value="year">按年份</option></select></div>
        <div class="zrb-filter-tabs">
          <button class="zrb-nav-item zrb-active" data-filter="all">全部 <b id="zrb-count-all">0</b></button>
          <button class="zrb-nav-item" data-filter="pending">待解析 <b id="zrb-count-pending">0</b></button>
          <button class="zrb-nav-item" data-filter="parsed">已解析 <b id="zrb-count-parsed">0</b></button>
          <button class="zrb-nav-item" data-filter="synced">已同步 <b id="zrb-count-synced">0</b></button>
          <button class="zrb-nav-item" data-filter="failed">需关注 <b id="zrb-count-failed">0</b></button>
          <span hidden="hidden"><b id="zrb-count-parsing">0</b><b id="zrb-count-ready">0</b></span>
        </div>
        <div class="zrb-list-heading"><strong id="zrb-list-title">全部文献</strong><span id="zrb-list-count"></span></div>
        <div id="zrb-items" class="zrb-items"></div>
        <div class="zrb-footer-bar"><span id="zrb-footer-text">本地账本</span><div><button id="zrb-export" class="zrb-button zrb-secondary">导出</button><button id="zrb-sync" class="zrb-button zrb-secondary">↑ 同步</button></div></div>
      </div>
    </section>
  </main>
</div>`;
