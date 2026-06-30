/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function () {
	const vscode = acquireVsCodeApi();

	const promptEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('prompt'));
	const transcriptEl = /** @type {HTMLElement} */ (document.getElementById('transcript'));
	const summaryEl = /** @type {HTMLElement} */ (document.getElementById('summary'));
	const modelEl = /** @type {HTMLSelectElement} */ (document.getElementById('model'));
	const indepEl = /** @type {HTMLSelectElement} */ (document.getElementById('independence'));
	const keyBanner = /** @type {HTMLElement} */ (document.getElementById('keybanner'));
	const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send'));
	const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById('stop'));
	const suggestEl = /** @type {HTMLElement} */ (document.getElementById('suggest'));
	const tokensEl = /** @type {HTMLElement} */ (document.getElementById('tokens'));

	/** @type {HTMLElement | null} */ let streamingEl = null;
	let streamingRaw = '';
	/** @type {HTMLElement | null} */ let toolGroup = null;
	let toolCount = 0;
	/** @type {{name:string,description:string}[]} */ let skills = [];

	const scrollDown = () => { transcriptEl.scrollTop = transcriptEl.scrollHeight; };
	const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

	const EXAMPLES = [
		'Explore this repo and tell me what it does, then run the tests.',
		'Compare three models on the iris dataset and write it up.',
		'Load the data, clean it, and show me what stands out.'
	];
	function showWelcome() {
		if (transcriptEl.querySelector('.mq-msg, .mq-toolgroup')) { return; }
		transcriptEl.innerHTML = '<div class="mq-welcome"><div class="mq-welcome-title">What should we research?</div>'
			+ '<div class="mq-welcome-sub">Ask in plain English — I work in your notebook and files, run code, and capture findings.</div>'
			+ EXAMPLES.map(e => '<button class="mq-example">' + esc(e) + '</button>').join('') + '</div>';
	}
	function clearWelcome() { const w = transcriptEl.querySelector('.mq-welcome'); if (w) { w.remove(); } }

	/** Minimal, safe Markdown → HTML (code, bold, italic, headings, lists, links). */
	function md(src) {
		const lines = String(src).split('\n');
		let html = '';
		let inCode = false;
		let inList = false;
		for (const line of lines) {
			const fence = line.match(/^```(\w*)/);
			if (fence) {
				if (inCode) { html += '</code></pre>'; inCode = false; }
				else { if (inList) { html += '</ul>'; inList = false; } html += '<pre class="mq-code"><code>'; inCode = true; }
				continue;
			}
			if (inCode) { html += esc(line) + '\n'; continue; }
			let t = esc(line);
			t = t.replace(/`([^`]+)`/g, '<code>$1</code>')
				.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
				.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
				.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="mq-mdlink" title="$2">$1</a>');
			const h = line.match(/^(#{1,4})\s+(.*)$/);
			const bullet = line.match(/^\s*[-*]\s+(.*)$/);
			if (h) { if (inList) { html += '</ul>'; inList = false; } html += '<div class="mq-h">' + esc(h[2]) + '</div>'; }
			else if (bullet) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + t.replace(/^\s*[-*]\s+/, '') + '</li>'; }
			else { if (inList) { html += '</ul>'; inList = false; } html += t ? '<div>' + t + '</div>' : '<div class="mq-sp"></div>'; }
		}
		if (inCode) { html += '</code></pre>'; }
		if (inList) { html += '</ul>'; }
		return html;
	}

	function bubble(role) {
		toolGroup = null;
		clearWelcome();
		const msg = document.createElement('div');
		msg.className = 'mq-msg ' + role;
		const roleEl = document.createElement('span');
		roleEl.className = 'mq-role';
		roleEl.textContent = role === 'you' ? 'You' : 'MiniQualia';
		const body = document.createElement('div');
		body.className = 'mq-body';
		msg.appendChild(roleEl);
		msg.appendChild(body);
		transcriptEl.appendChild(msg);
		scrollDown();
		return body;
	}

	function addMessage(role, text, asMarkdown) {
		const body = bubble(role);
		if (asMarkdown) { body.innerHTML = md(text); } else { body.textContent = text; }
		scrollDown();
	}

	function addTool(label, output) {
		if (!toolGroup) {
			clearWelcome();
			toolCount = 0;
			const details = document.createElement('details');
			details.className = 'mq-toolgroup';
			details.innerHTML = '<summary>Ran 0 tools</summary><div class="mq-toollist"></div>';
			transcriptEl.appendChild(details);
			toolGroup = details;
		}
		toolCount++;
		const row = document.createElement('details');
		row.className = 'mq-tool';
		const out = (output || '').trim();
		row.innerHTML = '<summary>' + esc(label) + '</summary>' + (out ? '<pre class="mq-out">' + esc(out.slice(0, 4000)) + '</pre>' : '');
		toolGroup.querySelector('.mq-toollist').appendChild(row);
		toolGroup.querySelector('summary').textContent = 'Ran ' + toolCount + (toolCount === 1 ? ' tool' : ' tools');
		scrollDown();
	}

	const card = (label, value) => '<div class="mq-card"><div class="mq-label">' + label + '</div><div class="mq-value">' + value + '</div></div>';

	function renderSummary(data) {
		const c = data.counts;
		const cards = [card('Notebook', data.notebook || '—'), card('Tasks', c.completed + ' / ' + c.total), card('Running', String(c.inProgress)), card('Findings', String(data.findings))];
		if (c.failed) { cards.push(card('Failed', String(c.failed))); }
		let html = cards.join('');
		if (data.agents && data.agents.length) {
			html += '<div class="mq-agents">' + data.agents.map(a => '<span class="mq-chip" data-status="' + a.status + '">' + a.label + ' · ' + a.status + '</span>').join('') + '</div>';
		}
		summaryEl.innerHTML = html;
	}

	function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

	function fillSelect(sel, values, current) {
		if (sel.options.length !== values.length) { sel.innerHTML = values.map(v => '<option value="' + v + '">' + v + '</option>').join(''); }
		sel.value = current;
	}

	function sendChat() {
		const text = promptEl.value.trim();
		if (!text) { return; }
		addMessage('you', text, false);
		vscode.postMessage({ type: 'userMessage', text: text });
		promptEl.value = '';
		hideSuggest();
	}

	// Slash-skill autocomplete.
	const currentSlashTerm = () => { const m = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/.exec(promptEl.value); return m ? m[1] : null; };
	const hideSuggest = () => { suggestEl.hidden = true; suggestEl.innerHTML = ''; };
	function showSuggest() {
		const term = currentSlashTerm();
		if (term === null) { hideSuggest(); return; }
		const matches = skills.filter(s => s.name.toLowerCase().startsWith(term.toLowerCase())).slice(0, 6);
		if (!matches.length) { hideSuggest(); return; }
		suggestEl.innerHTML = matches.map(s => '<div class="mq-suggest-row" data-name="' + s.name + '"><b>/' + s.name + '</b> <span>' + esc(s.description) + '</span></div>').join('');
		suggestEl.hidden = false;
	}
	function applySuggest(name) {
		promptEl.value = promptEl.value.replace(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/, m => (m.startsWith(' ') ? ' ' : '') + '/' + name + ' ');
		hideSuggest();
		promptEl.focus();
	}
	suggestEl.addEventListener('click', e => { const r = /** @type {HTMLElement} */ (e.target).closest('.mq-suggest-row'); if (r) { applySuggest(r.getAttribute('data-name')); } });
	transcriptEl.addEventListener('click', e => { const ex = /** @type {HTMLElement} */ (e.target).closest('.mq-example'); if (ex) { promptEl.value = ex.textContent || ''; promptEl.focus(); } });

	sendBtn.addEventListener('click', sendChat);
	stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
	document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
	document.getElementById('plan').addEventListener('click', () => vscode.postMessage({ type: 'plan', prompt: promptEl.value.trim() || undefined }));
	document.getElementById('runReady').addEventListener('click', () => vscode.postMessage({ type: 'runReady' }));
	document.getElementById('capture').addEventListener('click', () => vscode.postMessage({ type: 'capture' }));
	document.getElementById('export').addEventListener('click', () => vscode.postMessage({ type: 'export' }));
	document.getElementById('setKey').addEventListener('click', () => vscode.postMessage({ type: 'setKey' }));
	modelEl.addEventListener('change', () => vscode.postMessage({ type: 'setModel', value: modelEl.value }));
	indepEl.addEventListener('change', () => vscode.postMessage({ type: 'setIndependence', value: indepEl.value }));

	promptEl.addEventListener('input', showSuggest);
	promptEl.addEventListener('keydown', e => {
		if (!suggestEl.hidden && e.key === 'Enter') { const f = suggestEl.querySelector('.mq-suggest-row'); if (f) { e.preventDefault(); applySuggest(f.getAttribute('data-name')); return; } }
		if (e.key === 'Escape') { hideSuggest(); return; }
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
	});

	window.addEventListener('message', event => {
		const m = event.data;
		switch (m.type) {
			case 'transcript': addMessage(m.role, m.text, m.role === 'miniqualia'); break;
			case 'tool': addTool(m.label, m.output); break;
			case 'assistantStart': streamingRaw = ''; streamingEl = bubble('miniqualia'); break;
			case 'assistantDelta':
				if (!streamingEl) { streamingRaw = ''; streamingEl = bubble('miniqualia'); }
				streamingRaw += m.text; streamingEl.innerHTML = md(streamingRaw); scrollDown(); break;
			case 'assistantEnd':
				if (streamingEl && !streamingRaw.trim()) { const p = streamingEl.parentElement; if (p) { p.remove(); } }
				streamingEl = null; break;
			case 'summary': renderSummary(m.data); break;
			case 'usage': tokensEl.textContent = (m.input || m.output) ? ('↑' + fmt(m.input) + ' ↓' + fmt(m.output) + ' tok') : ''; break;
			case 'keyStatus':
				fillSelect(modelEl, m.models || [], m.model || '');
				fillSelect(indepEl, m.independenceLevels || [], m.independence || 'high');
				keyBanner.hidden = !!m.hasKey; break;
			case 'skills': skills = m.skills || []; break;
			case 'busy':
				sendBtn.hidden = !!m.value; stopBtn.hidden = !m.value;
				sendBtn.disabled = !!m.value; break;
			case 'cleared': transcriptEl.innerHTML = ''; toolGroup = null; streamingEl = null; showWelcome(); break;
			case 'restore':
				transcriptEl.innerHTML = ''; toolGroup = null;
				for (const e of (m.entries || [])) {
					if (e.kind === 'assistant') { addMessage('miniqualia', e.text || '', true); }
					else if (e.kind === 'tool') { addTool(e.label, e.output); }
					else { addMessage(e.role || 'system', e.text || '', e.role === 'miniqualia'); }
				}
				showWelcome();
				break;
			case 'insertPrompt': promptEl.value = (promptEl.value ? promptEl.value.trimEnd() + '\n' : '') + m.text; promptEl.focus(); break;
		}
	});

	showWelcome();
	vscode.postMessage({ type: 'ready' });
}());
