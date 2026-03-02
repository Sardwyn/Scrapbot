// src/views/metricsView.js
// Single-file HTML view for Scrapbot Metrics + Command Test Lab.

export function renderMetricsHtml({ secret }) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Scrapbot | Metrics & Test Lab</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0f172a;
            --card-bg: #1e293b;
            --accent: #38bdf8;
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --border: #334155;
            --success: #22c55e;
            --error: #ef4444;
            --warning: #f59e0b;
        }

        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 0;
            background: var(--bg);
            color: var(--text-primary);
            font-family: 'Inter', sans-serif;
            line-height: 1.5;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            border-bottom: 1px solid var(--border);
            padding-bottom: 1rem;
        }

        h1 { margin: 0; font-size: 1.5rem; font-weight: 700; color: var(--accent); }

        .tabs {
            display: flex;
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .tab {
            padding: 0.5rem 1rem;
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-secondary);
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.2s;
        }

        .tab.active {
            background: var(--accent);
            color: var(--bg);
            border-color: var(--accent);
        }

        .section { display: none; }
        .section.active { display: block; }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
            box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
        }

        .card-title {
            margin-top: 0;
            margin-bottom: 1rem;
            font-size: 1.125rem;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        /* --- Runner Styles --- */
        .runner-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1.5rem;
        }

        .form-group { margin-bottom: 1rem; }
        label { display: block; margin-bottom: 0.5rem; font-size: 0.875rem; color: var(--text-secondary); }
        input, select {
            width: 100%;
            background: #0f172a;
            border: 1px solid var(--border);
            color: var(--text-primary);
            padding: 0.75rem;
            border-radius: 6px;
            font-family: inherit;
        }

        button.primary {
            background: var(--accent);
            color: var(--bg);
            border: none;
            padding: 0.75rem 1.5rem;
            border-radius: 6px;
            font-weight: 600;
            cursor: pointer;
            width: 100%;
        }

        /* --- Trace Viewer --- */
        .trace-view {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.875rem;
            background: #020617;
            padding: 1rem;
            border-radius: 8px;
            overflow-x: auto;
            white-space: pre-wrap;
            border: 1px solid var(--border);
            margin-top: 1rem;
        }

        .badge {
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }
        .badge-success { background: rgba(34, 197, 94, 0.2); color: var(--success); }
        .badge-error { background: rgba(239, 68, 68, 0.2); color: var(--error); }
        .badge-warning { background: rgba(245, 158, 11, 0.2); color: var(--warning); }

        /* --- Test Buttons --- */
        .test-buttons {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 0.75rem;
        }

        .btn-test {
            background: #334155;
            color: white;
            border: none;
            padding: 0.75rem;
            border-radius: 6px;
            cursor: pointer;
            text-align: left;
            font-size: 0.875rem;
        }

        .btn-test:hover { background: #475569; }

        .timeline-item {
            border-left: 2px solid var(--border);
            padding-left: 1rem;
            margin-bottom: 1rem;
            position: relative;
        }

        .timeline-item::before {
            content: '';
            position: absolute;
            left: -6px;
            top: 0;
            width: 10px;
            height: 10px;
            background: var(--bg);
            border: 2px solid var(--accent);
            border-radius: 50%;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>SCRAPBOT / TEST LAB</h1>
            <div>
                <span class="badge badge-success">Live Engine</span>
            </div>
        </header>

        <div class="tabs">
            <button class="tab active" onclick="switchTab('commands')">Command Lab</button>
            <button class="tab" onclick="switchTab('metrics')">System Metrics</button>
        </div>

        <!-- COMMAND LAB SECTION -->
        <div id="commands" class="section active">
            <div class="runner-grid">
                <div>
                    <div class="card">
                        <h2 class="card-title">Message Runner</h2>
                        <form id="runnerForm">
                            <div class="form-group">
                                <label>Message Text</label>
                                <input type="text" id="messageText" value="!help" placeholder="e.g. !hello">
                            </div>
                            <div class="form-group" style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;">
                                <div>
                                    <label>User Role</label>
                                    <select id="userRole">
                                        <option value="everyone">Everyone</option>
                                        <option value="mod">Moderator</option>
                                        <option value="broadcaster">Broadcaster</option>
                                    </select>
                                </div>
                                <div>
                                    <label>User Name</label>
                                    <input type="text" id="userName" value="test_user">
                                </div>
                            </div>
                            <button type="submit" class="primary">Execute Pipeline (Dry Run)</button>
                        </form>
                    </div>

                    <div class="card">
                        <h2 class="card-title">Test Suite (Deterministic)</h2>
                        <div class="test-buttons" id="testCaseButtons">
                            <!-- Populated via JS -->
                        </div>
                    </div>

                    <div class="card" style="border-left: 4px solid var(--accent);">
                        <h2 class="card-title">Variable Cheat Sheet</h2>
                        <div style="font-size: 0.8125rem;">
                            <div style="margin-bottom: 0.75rem;">
                                <code style="color:var(--accent);">$1...$9</code> 
                                <span style="color:var(--text-secondary)">- Positional words after trigger.</span>
                            </div>
                            <div style="margin-bottom: 0.75rem;">
                                <code style="color:var(--accent);">$args</code> 
                                <span style="color:var(--text-secondary)">- Everything after the command.</span>
                            </div>
                            <div style="margin-bottom: 0.75rem;">
                                <code style="color:var(--accent);">{user}</code> 
                                <span style="color:var(--text-secondary)">- The person typing the message.</span>
                            </div>
                            <div style="margin-bottom: 0.75rem;">
                                <code style="color:var(--accent);">{channel}</code> 
                                <span style="color:var(--text-secondary)">- The current channel slug.</span>
                            </div>
                            <hr style="border:0; border-top:1px solid var(--border); margin: 0.75rem 0;">
                            <div style="margin-bottom: 0.5rem;">
                                <code style="color:var(--warning);">$random(a,b,c)</code>
                                <div style="color:var(--text-secondary); font-size: 0.75rem;">Randomly picks one choice.</div>
                            </div>
                            <div>
                                <code style="color:var(--warning);">$toupper() / $tolower()</code>
                                <div style="color:var(--text-secondary); font-size: 0.75rem;">Case manipulation.</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div>
                    <div class="card" style="min-height: 500px;">
                        <h2 class="card-title">Trace Viewer</h2>
                        <div id="traceResult">
                            <p style="color: var(--text-secondary); text-align: center; margin-top: 4rem;">
                                Run a message to see the execution trace.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- METRICS SECTION -->
        <div id="metrics" class="section">
            <div class="card">
                <h2 class="card-title">System Snapshots</h2>
                <div id="metricsData" class="trace-view">Loading...</div>
            </div>
        </div>
    </div>

    <script>
        const SECRET = "${secret}";
        
        function switchTab(tabId) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
            
            document.querySelector(\`button[onclick*="\${tabId}"]\`).classList.add('active');
            document.getElementById(tabId).classList.add('active');

            if (tabId === 'metrics') loadMetrics();
            if (tabId === 'commands') loadTestCases();
        }

        async function api(path, method = 'GET', body = null) {
            const options = {
                method,
                headers: {
                    'x-scrapbot-secret': SECRET,
                    'Content-Type': 'application/json'
                }
            };
            if (body) options.body = JSON.stringify(body);
            const resp = await fetch(path, options);
            return resp.json();
        }

        async function loadTestCases() {
            const data = await api('/api/metrics/tests/commands');
            const container = document.getElementById('testCaseButtons');
            container.innerHTML = '';
            data.tests.forEach(test => {
                const btn = document.createElement('button');
                btn.className = 'btn-test';
                btn.innerText = test.name;
                btn.onclick = () => runTest(test.id);
                container.appendChild(btn);
            });
        }

        async function runTest(testId) {
            const result = await api('/api/metrics/tests/commands/run', 'POST', { test_id: testId });
            renderTrace(result);
        }

        document.getElementById('runnerForm').onsubmit = async (e) => {
            e.preventDefault();
            const body = {
                messageText: document.getElementById('messageText').value,
                userRole: document.getElementById('userRole').value,
                userName: document.getElementById('userName').value
            };
            const result = await api('/api/metrics/tests/commands/run', 'POST', body);
            renderTrace(result);
        };

        function renderTrace(data) {
            const container = document.getElementById('traceResult');
            const trace = data.trace;
            
            let passedHtml = data.passed 
                ? '<span class="badge badge-success">Passed Expectations</span>' 
                : '<span class="badge badge-error">Failed Expectations</span>';
            
            if (!data.assertions || data.assertions.length === 0) passedHtml = '';

            const actionsHtml = trace.actions_results.length > 0 
                ? trace.actions_results.map(a => \`
                    <div style="margin-top: 0.5rem; padding: 0.5rem; background: rgba(56, 189, 248, 0.1); border: 1px dashed var(--accent); border-radius:4px;">
                        <strong>Dispatch Chat:</strong> \${a.text}
                    </div>
                \`).join('')
                : '<div style="color: var(--text-secondary)">No actions dispatched</div>';

            container.innerHTML = \`
                <div style="margin-bottom: 2rem;">
                    \${passedHtml}
                    <div style="margin-top: 0.5rem; font-size: 0.875rem; color: var(--text-secondary);">
                        Command: <strong>\${trace.command.name || 'None (No Match)'}</strong>
                    </div>
                </div>

                <div class="timeline-item">
                    <strong>1. Normalization</strong>
                    <div style="color: var(--text-secondary); font-size: 0.75rem;">
                        Input: "\${trace.input.messageText}" as \${trace.input.userRole}
                    </div>
                </div>

                <div class="timeline-item">
                    <strong>2. Argument Extraction</strong>
                    <div style="font-size: 0.8125rem;">
                        Args: \${trace.command.args && trace.command.args.length > 0 ? trace.command.args.map(a => \`<span class="badge" style="background:rgba(255,255,255,0.1)">\${a}</span>\`).join(' ') : '<span style="color:var(--text-secondary)">None</span>'}
                    </div>
                </div>

                <div class="timeline-item">
                    <strong>3. Pipeline Execution</strong>
                    <div style="font-size: 0.8125rem;">
                        Match Status: \${trace.command.matched ? '<span style="color:var(--success)">MATCHED</span>' : '<span style="color:var(--text-secondary)">NO MATCH</span>'}
                        \${trace.command.denied ? \`<span style="color:var(--error)">DENIED (\${trace.command.reason})</span>\` : ''}
                    </div>
                </div>

                <div class="timeline-item">
                    <strong>3. Actions Preview</strong>
                    \${actionsHtml}
                </div>

                <details style="margin-top: 2rem;">
                    <summary style="cursor:pointer; color: var(--accent); font-size: 0.75rem;">View Raw Trace JSON</summary>
                    <div class="trace-view">\${JSON.stringify(data, null, 2)}</div>
                </details>
            \`;
        }

        async function loadMetrics() {
            const data = await api('/api/metrics');
            document.getElementById('metricsData').innerText = JSON.stringify(data, null, 2);
        }

        // Init
        loadTestCases();
    </script>
</body>
</html>
  `;
}
