/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const listEl = /** @type {HTMLElement} */ (document.getElementById('list'));
	const searchEl = /** @type {HTMLInputElement} */ (document.getElementById('search'));
	const sortEl = /** @type {HTMLSelectElement} */ (document.getElementById('sort'));
	const chipsEl = /** @type {HTMLElement} */ (document.getElementById('chips'));

	/** @type {any[]} */ let claims = [];
	let filter = 'all';
	let search = '';

	function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

	function matches(c) {
		if (filter === 'captured' && c.kind !== 'notebook-captured') { return false; }
		if (filter === 'synthesized' && c.kind !== 'synthesized') { return false; }
		if (filter === 'key' && !c.highLevel) { return false; }
		if (filter === 'stale' && !c.stale) { return false; }
		if (search && !(c.claim + ' ' + c.id).toLowerCase().includes(search)) { return false; }
		return true;
	}

	function sorted(list) {
		const arr = list.slice();
		if (sortEl.value === 'oldest') { arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
		else if (sortEl.value === 'key') { arr.sort((a, b) => (Number(b.highLevel) - Number(a.highLevel)) || b.createdAt.localeCompare(a.createdAt)); }
		else { arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
		return arr;
	}

	function card(c) {
		const related = (c.related && c.related.length) ? ' · builds on ' + c.related.map(r => '<span class="k-link" data-open="' + r + '">' + r + '</span>').join(', ') : '';
		const metric = (c.metric !== undefined && c.metric !== null) ? '<span class="k-metric">' + c.metric + '</span>' : '';
		return '<div class="k-card" data-kind="' + c.kind + '"' + (c.highLevel ? ' data-key="1"' : '') + (c.stale ? ' data-stale="1"' : '') + '>'
			+ '<div class="k-head">'
			+ '<span class="k-id">' + (c.highLevel ? '* ' : '') + esc(c.id) + '</span>'
			+ '<span class="k-badge ' + c.kind + '">' + (c.kind === 'notebook-captured' ? 'captured' : 'synthesized') + '</span>'
			+ (c.stale ? '<span class="k-badge stale">stale</span>' : '')
			+ metric
			+ '</div>'
			+ '<div class="k-claim">' + esc(c.claim) + '</div>'
			+ '<div class="k-src"><span class="k-link" data-open="' + c.id + '">' + esc(c.source) + '</span>' + related + '</div>'
			+ '<div class="k-actions">'
			+ '<button data-act="validate" data-id="' + c.id + '">Validate</button>'
			+ '<button data-act="validateUpstream" data-id="' + c.id + '">↑ Upstream</button>'
			+ '<button data-act="toggleHighLevel" data-id="' + c.id + '">' + (c.highLevel ? 'Unstar' : 'Star') + '</button>'
			+ '</div></div>';
	}

	function render() {
		const visible = sorted(claims.filter(matches));
		if (!visible.length) {
			listEl.innerHTML = '<div class="k-empty">' + (claims.length ? 'No claims match.' : 'No claims captured yet. Run tasks or ask the agent to capture findings.') + '</div>';
			return;
		}
		listEl.innerHTML = visible.map(card).join('');
	}

	chipsEl.addEventListener('click', e => {
		const btn = /** @type {HTMLElement} */ (e.target).closest('.k-chip');
		if (!btn) { return; }
		chipsEl.querySelectorAll('.k-chip').forEach(c => c.classList.remove('active'));
		btn.classList.add('active');
		filter = btn.getAttribute('data-filter');
		render();
	});
	searchEl.addEventListener('input', () => { search = searchEl.value.trim().toLowerCase(); render(); });
	sortEl.addEventListener('change', render);
	document.getElementById('graph').addEventListener('click', () => vscode.postMessage({ type: 'graph' }));
	document.getElementById('import').addEventListener('click', () => vscode.postMessage({ type: 'import' }));

	listEl.addEventListener('click', e => {
		const t = /** @type {HTMLElement} */ (e.target);
		const open = t.closest('[data-open]');
		if (open) { vscode.postMessage({ type: 'openSource', id: open.getAttribute('data-open') }); return; }
		const act = t.closest('[data-act]');
		if (act) { vscode.postMessage({ type: act.getAttribute('data-act'), id: act.getAttribute('data-id') }); }
	});

	window.addEventListener('message', event => {
		if (event.data.type === 'claims') { claims = event.data.claims || []; render(); }
	});

	vscode.postMessage({ type: 'ready' });
}());
