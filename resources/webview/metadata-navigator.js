/* Ограниченные страницы и виртуальный viewport: DOM содержит видимые строки с overscan. */
(() => {
	const api = acquireVsCodeApi();
	const tree = document.getElementById('tree'), canvas = document.getElementById('canvas');
	const input = document.getElementById('query'), status = document.getElementById('status'), menu = document.getElementById('menu');
	const nodes = new Map(), lists = new Map(), pending = new Set();
	let epoch = -1, selected, rows = [], searchTimer, dirty = false, scheduled = false, revision = -1, menuPoint, revealTarget;
	const height = 24;
	const send = message => api.postMessage({ ...message, epoch });
	const closeMenu = () => { menu.hidden = true; menu.replaceChildren(); };
	function children(parent, offset = 0) {
		const key = `${parent || ''}:${offset}`;
		if (!pending.has(key)) { pending.add(key); send({ type: 'children', parent, offset }); }
	}
	function flatten() {
		rows = [];
		const walk = (parent, depth) => {
			const list = lists.get(parent || '');
			if (!list) { children(parent); return; }
			let next = 0;
			for (const [offset, ids] of [...list.pages].sort((a, b) => a[0] - b[0])) {
				if (offset > next) { rows.push({ parent, depth, more: true, offset: next }); }
				ids.forEach((id, index) => {
					const node = nodes.get(id);
					rows.push({ node, depth, parent, position: offset + index + 1, total: list.total });
					if (node.expanded) { walk(id, depth + 1); }
				});
				next = offset + ids.length;
			}
			if (next < list.total) { rows.push({ parent, depth, more: true, offset: next }); }
		};
		walk(undefined, 0);
		if (revealTarget) {
			const index = rows.findIndex(row => row.node?.id === revealTarget.id);
			if (index >= 0) { tree.scrollTop = index * height; if (revealTarget.focus) { tree.focus(); } revealTarget = undefined; }
		}
		render();
	}
	function select(node, open = false) {
		closeMenu(); selected = node.id;
		send({ type: open ? 'open' : 'select', id: node.id }); tree.focus(); render();
	}
	function expand(node, value) {
		if (!node.expandable) { return; }
		node.expanded = value; send({ type: 'expand', id: node.id, expanded: value }); flatten();
	}
	function context(node, x, y) {
		select(node); menuPoint = { x, y }; send({ type: 'context', id: node.id });
	}
	function render() {
		canvas.style.height = `${rows.length * height}px`;
		const from = Math.max(0, Math.floor(tree.scrollTop / height) - 6);
		const to = Math.min(rows.length, from + Math.ceil(tree.clientHeight / height) + 12);
		const fragment = document.createDocumentFragment();
		for (let i = from; i < to; i++) {
			const row = rows[i], el = document.createElement('div');
			el.className = 'row'; el.style.top = `${i * height}px`; el.style.paddingLeft = `${8 + row.depth * 12}px`;
			el.setAttribute('role', 'treeitem'); el.setAttribute('aria-level', String(row.depth + 1));
			if (row.more) {
				el.classList.add('more'); const button = document.createElement('button'); button.textContent = 'Показать ещё…';
				button.onclick = () => children(row.parent, row.offset); el.append(button);
			} else {
				const node = row.node; el.id = `node-${node.id}`; el.dataset.id = node.id;
				el.setAttribute('aria-selected', String(selected === node.id)); el.setAttribute('aria-setsize', String(row.total)); el.setAttribute('aria-posinset', String(row.position));
				if (node.expandable) { el.setAttribute('aria-expanded', String(node.expanded)); }
				el.classList.toggle('selected', selected === node.id); el.title = node.tooltip || node.label;
				const twisty = document.createElement('button'); twisty.className = 'twisty'; twisty.tabIndex = -1; twisty.disabled = !node.expandable;
				twisty.classList.toggle('expanded', node.expanded);
				twisty.setAttribute('aria-label', node.expanded ? 'Свернуть' : 'Развернуть');
				twisty.onclick = event => { event.stopPropagation(); select(node); expand(node, !node.expanded); }; el.append(twisty);
				if (node.icon) {
					for (const theme of ['light', 'dark']) { const icon = document.createElement('img'); icon.className = `icon-${theme}`; icon.src = node.icon[theme]; icon.alt = ''; el.append(icon); }
				} else { const icon = document.createElement('span'); icon.className = 'theme-icon'; icon.textContent = ['error', 'warning'].includes(node.themeIcon) ? '⚠' : node.themeIcon === 'info' ? 'ⓘ' : node.themeIcon === 'search' ? '⌕' : ''; el.append(icon); }
				const label = document.createElement('span'); label.className = 'label'; label.textContent = node.label; el.append(label);
				if (node.description) { const text = document.createElement('span'); text.className = 'description'; text.textContent = node.description; el.append(text); }
				el.onclick = () => select(node, true); el.ondblclick = () => expand(node, !node.expanded);
				el.oncontextmenu = event => { event.preventDefault(); context(node, event.clientX, event.clientY); };
			}
			fragment.append(el);
		}
		canvas.replaceChildren(fragment);
		if (selected && document.getElementById(`node-${selected}`)) { tree.setAttribute('aria-activedescendant', `node-${selected}`); }
		else { tree.removeAttribute('aria-activedescendant'); }
	}
	function move(index) {
		index = Math.min(rows.length - 1, Math.max(0, index)); const row = rows[index]; if (!row) { return; }
		if (row.more) { children(row.parent, row.offset); return; }
		select(row.node); if (index * height < tree.scrollTop) { tree.scrollTop = index * height; }
		if ((index + 1) * height > tree.scrollTop + tree.clientHeight) { tree.scrollTop = (index + 1) * height - tree.clientHeight; } render();
	}
	tree.onkeydown = event => {
		const index = rows.findIndex(row => row.node?.id === selected), row = rows[index];
		if (event.key === 'ArrowDown') { event.preventDefault(); move(index + 1); }
		else if (event.key === 'ArrowUp') { event.preventDefault(); move(index < 0 ? 0 : index - 1); }
		else if (event.key === 'Home') { event.preventDefault(); move(0); }
		else if (event.key === 'End') { event.preventDefault(); move(rows.length - 1); }
		else if (row && event.key === 'ArrowRight') { event.preventDefault(); if (!row.node.expanded) { expand(row.node, true); } else if (rows[index + 1]?.parent === selected) { move(index + 1); } }
		else if (row && event.key === 'ArrowLeft') { event.preventDefault(); if (row.node.expanded) { expand(row.node, false); } else { move(rows.findIndex(value => value.node?.id === row.parent)); } }
		else if (row && event.key === 'Enter') { event.preventDefault(); select(row.node, true); if (!row.node.openable) { expand(row.node, !row.node.expanded); } }
		else if (row && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) { event.preventDefault(); const bounds = tree.getBoundingClientRect(); context(row.node, bounds.left + 24, bounds.top + Math.max(0, index * height - tree.scrollTop)); }
		else if (event.key === 'Escape') { closeMenu(); }
	};
	tree.addEventListener('scroll', () => { closeMenu(); if (!scheduled) { scheduled = true; requestAnimationFrame(() => { scheduled = false; render(); }); } });
	new ResizeObserver(render).observe(tree);
	input.addEventListener('input', () => { dirty = true; clearTimeout(searchTimer); searchTimer = setTimeout(() => { dirty = false; send({ type: 'search', query: input.value }); }, 250); });
	const clear = () => { clearTimeout(searchTimer); dirty = false; input.value = ''; send({ type: 'search', query: '' }); input.focus(); };
	input.onkeydown = event => { if (event.key === 'Escape') { clear(); } if (event.key === 'ArrowDown') { event.preventDefault(); move(0); } };
	document.getElementById('clear').onclick = clear;
	for (const button of document.querySelectorAll('[data-action]')) { button.onclick = () => send({ type: 'action', action: button.dataset.action, revision }); }
	document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) { closeMenu(); } });
	menu.onkeydown = event => {
		const buttons = [...menu.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
		if (event.key === 'Escape') { closeMenu(); tree.focus(); }
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
	};
	function page(msg) {
		pending.delete(`${msg.parent || ''}:${msg.offset}`); const key = msg.parent || '', list = lists.get(key) || { pages: new Map(), total: 0 };
		for (const node of msg.nodes) { nodes.set(node.id, node); if (node.selected) { selected = node.id; } }
		list.pages.set(msg.offset, msg.nodes.map(node => node.id)); list.total = msg.total; lists.set(key, list);
	}
	window.addEventListener('message', ({ data: msg }) => {
		if (msg.type === 'reset') { closeMenu(); epoch = msg.epoch; nodes.clear(); lists.clear(); pending.clear(); selected = undefined; status.hidden = true; tree.scrollTop = 0; if (!dirty) { input.value = msg.query; } children(); flatten(); }
		if (msg.type === 'children' && msg.epoch === epoch) { page(msg); flatten(); }
		if (msg.type === 'reveal') { for (const value of msg.pages) { if (value.epoch === epoch) { page(value); } } revealTarget = msg; flatten(); }
		if (msg.type === 'setQuery') { dirty = false; clearTimeout(searchTimer); input.value = msg.query; }
		if (msg.type === 'focusSearch') { input.focus(); }
		if (msg.type === 'toolbar') {
			revision = msg.revision;
			for (const button of document.querySelectorAll('[data-action]')) {
				const action = button.dataset.action;
				if (['add', 'open', 'duplicate', 'delete'].includes(action)) { button.disabled = !msg.enabled.includes(action); }
				if (action === 'filters') { button.setAttribute('aria-pressed', String(!!msg.filterCaption)); button.title = msg.filterCaption ? `Отбор: ${msg.filterCaption}` : 'Отбор по подсистемам'; }
				if (action === 'clearFilter') { button.hidden = !msg.filterCaption; }
			}
		}
		if (msg.type === 'menu' && msg.id === selected && menuPoint) {
			menu.replaceChildren();
			for (const entry of msg.entries) { const button = document.createElement('button'); button.setAttribute('role', 'menuitem'); button.textContent = entry.title; button.onclick = () => { send({ type: 'menuAction', id: msg.id, index: entry.index }); closeMenu(); tree.focus(); }; menu.append(button); }
			if (msg.entries.length) { menu.hidden = false; menu.style.left = '4px'; menu.style.top = '4px'; menu.style.left = `${Math.max(4, Math.min(menuPoint.x, innerWidth - menu.offsetWidth - 4))}px`; menu.style.top = `${Math.max(4, Math.min(menuPoint.y, innerHeight - menu.offsetHeight - 4))}px`; menu.querySelector('button')?.focus(); }
		}
		if (msg.type === 'error' && msg.epoch === epoch) { pending.clear(); status.hidden = false; status.textContent = msg.message; }
	});
	api.postMessage({ type: 'ready' });
})();

