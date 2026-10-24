App.registerModule('reports', {
  render(container) {
    container.innerHTML = `
      <div class="section-header">
        <div>
          <div class="section-title">Weekly Reports</div>
          <div class="section-sub">Reporting and status summaries</div>
        </div>
      </div>
      <div class="card">
        <div class="empty-state">
          <div class="empty-icon">◪</div>
          <div class="empty-text">No weekly report generated yet.</div>
        </div>
      </div>
    `;
  }
});
