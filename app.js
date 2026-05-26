'use strict';

/* ── Reelogue SPA ─────────────────────────────────────────────────── */
const App = (() => {
  let ME = null;

  // ── helpers ────────────────────────────────────────────────────
  const $ = (s, r = document) => r.querySelector(s);
  const app = () => $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function api(url, opts) {
    const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('unauth'); }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.status === 204 ? null : r.json();
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1900);
  }

  function modal(html) {
    $('#modal').innerHTML = html;
    $('#modalBg').classList.add('show');
  }
  function closeModal() { $('#modalBg').classList.remove('show'); }
  $('#modalBg')?.addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });

  const initials = (name) => (name || '?').trim().charAt(0).toUpperCase();
  function avatar(u, cls) {
    if (u && u.avatar_url) return `<img src="${esc(u.avatar_url)}" alt="">`;
    return `<span>${esc(initials(u && u.display_name))}</span>`;
  }
  const stars = (r) => r ? '★'.repeat(Math.round(r / 2)) + '☆'.repeat(5 - Math.round(r / 2)) : '';
  const ago = (ts) => {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'только что';
    if (s < 3600) return Math.floor(s / 60) + ' мин назад';
    if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
    if (s < 2592000) return Math.floor(s / 86400) + ' дн назад';
    return new Date(ts).toLocaleDateString('ru-RU');
  };

  function posterCard(item) {
    const t = item.media_type === 'tv' ? 'tv' : 'movie';
    const ph = item.poster
      ? `<img loading="lazy" src="${esc(item.poster)}" alt="">`
      : `<div class="ph">${esc(item.title || '')}</div>`;
    const ribbon = item.media_type === 'tv' ? '<span class="ribbon">Сериал</span>' : '';
    const score = item.myscore ? `<span class="myscore">${item.myscore}</span>` : '';
    return `<div>
      <div class="poster" onclick="App.go('/film/${t}/${item.tmdb_id}')">
        ${ph}${ribbon}${score}
      </div>
      <div class="poster-cap"><b>${esc(item.title || '')}</b>
        <span>${esc(item.year || '')}</span></div>
    </div>`;
  }
  const grid = (items) => `<div class="grid">${items.map(posterCard).join('')}</div>`;

  // ── header ──────────────────────────────────────────────────────
  function renderHeader() {
    const btn = $('#meBtn');
    btn.innerHTML = `<span class="avatar-fallback">${avatar(ME)}</span>`;
    btn.onclick = (e) => { e.preventDefault(); go('/user/' + ME.username); };
  }

  function setActiveNav() {
    const route = (location.hash.slice(2).split('/')[0]) || '';
    document.querySelectorAll('#navLinks a').forEach((a) =>
      a.classList.toggle('active', a.dataset.route === route));
  }

  // ── live search ─────────────────────────────────────────────────
  let searchTimer = null;
  function initSearch() {
    const input = $('#search'), box = $('#searchResults');
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (!q) { box.classList.remove('show'); box.innerHTML = ''; return; }
      searchTimer = setTimeout(async () => {
        try {
          const d = await api('/api/tmdb/search?q=' + encodeURIComponent(q));
          const rows = d.results.slice(0, 8);
          if (!rows.length) { box.innerHTML = '<div class="sr-item">Ничего не найдено</div>'; }
          else box.innerHTML = rows.map((x) => {
            const t = x.media_type === 'tv' ? 'tv' : 'movie';
            const p = x.poster ? `<img src="${esc(x.poster)}">` : `<div class="sr-poster-fallback"></div>`;
            return `<div class="sr-item" onclick="App.pickSearch('${t}',${x.tmdb_id})">
              ${p}<div class="sr-meta"><b>${esc(x.title)}</b>
              <span>${x.media_type === 'tv' ? 'Сериал' : 'Фильм'} · ${esc(x.year || '—')}</span></div></div>`;
          }).join('');
          box.classList.add('show');
        } catch {}
      }, 280);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.searchbox')) box.classList.remove('show');
    });
  }
  function pickSearch(type, id) {
    $('#searchResults').classList.remove('show');
    $('#search').value = '';
    go('/film/' + type + '/' + id);
  }

  // ── router ──────────────────────────────────────────────────────
  function go(path) { location.hash = '#' + path; }
  async function route() {
    setActiveNav();
    const parts = location.hash.slice(2).split('/').filter(Boolean);
    window.scrollTo(0, 0);
    try {
      if (parts.length === 0) return viewHome();
      if (parts[0] === 'popular') return viewPopular();
      if (parts[0] === 'feed') return viewFeed();
      if (parts[0] === 'lists') return viewLists();
      if (parts[0] === 'list') return viewList(parts[1]);
      if (parts[0] === 'film') return viewFilm(parts[1], parts[2]);
      if (parts[0] === 'user') return viewProfile(parts[1]);
      viewHome();
    } catch (e) { if (e.message !== 'unauth') app().innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
  }

  // ═══ HOME ═══════════════════════════════════════════════════════
  async function viewHome() {
    app().innerHTML = '<div class="loader">Загрузка…</div>';
    const [trend, movies, tv] = await Promise.all([
      api('/api/tmdb/trending'),
      api('/api/tmdb/popular?type=movie'),
      api('/api/tmdb/popular?type=tv'),
    ]);
    const hero = trend.results.find((x) => x.backdrop) || trend.results[0];
    const t = hero.media_type === 'tv' ? 'tv' : 'movie';
    app().innerHTML = `
      <div class="hero" onclick="App.go('/film/${t}/${hero.tmdb_id}')" style="cursor:pointer">
        <div class="bg" style="background-image:url(${esc(hero.backdrop || hero.poster)})"></div>
        <div class="grad"></div>
        <div class="inner">
          <div class="meta">${hero.media_type === 'tv' ? 'Сериал недели' : 'Фильм недели'}</div>
          <h1>${esc(hero.title)}</h1>
          <p>${esc(hero.overview || '')}</p>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h2>В тренде</h2><span class="line"></span></div>
        ${grid(trend.results.slice(0, 12))}
      </div>
      <div class="section">
        <div class="section-head"><h2>Популярные фильмы</h2><span class="line"></span>
          <a href="#/popular">Все →</a></div>
        ${grid(movies.results.slice(0, 12))}
      </div>
      <div class="section">
        <div class="section-head"><h2>Популярные сериалы</h2><span class="line"></span></div>
        ${grid(tv.results.slice(0, 12))}
      </div>`;
  }

  // ═══ POPULAR ════════════════════════════════════════════════════
  let popState = { type: 'movie', page: 1, items: [] };
  async function viewPopular() {
    popState = { type: 'movie', page: 1, items: [] };
    app().innerHTML = `
      <div class="section">
        <div class="section-head">
          <h2>Популярное</h2><span class="line"></span>
          <button class="btn sm accent" onclick="App.randomFilm()">🎲 Случайный</button>
        </div>
        <div class="tabs" id="popTabs">
          <button class="active" data-t="movie">Фильмы</button>
          <button data-t="tv">Сериалы</button>
        </div>
        <div id="popGrid"></div>
        <div style="text-align:center;margin:30px 0">
          <button class="btn" id="moreBtn">Показать ещё</button>
        </div>
      </div>`;
    $('#popTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $('#popTabs').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      popState = { type: b.dataset.t, page: 1, items: [] };
      loadPopular();
    });
    $('#moreBtn').onclick = () => { popState.page++; loadPopular(true); };
    loadPopular();
  }
  async function loadPopular(append) {
    const d = await api(`/api/tmdb/popular?type=${popState.type}&page=${popState.page}`);
    popState.items = append ? popState.items.concat(d.results) : d.results;
    $('#popGrid').innerHTML = grid(popState.items);
  }
  async function randomFilm() {
    toast('Бросаем кости…');
    const x = await api('/api/tmdb/random');
    go('/film/' + x.media_type + '/' + x.tmdb_id);
  }

  // ═══ FILM PAGE ══════════════════════════════════════════════════
  async function viewFilm(type, id) {
    type = type === 'tv' ? 'tv' : 'movie';
    app().innerHTML = '<div class="loader">Загрузка…</div>';
    const [film, revs, state] = await Promise.all([
      api(`/api/tmdb/title/${type}/${id}`),
      api(`/api/reviews/${type}/${id}`),
      api(`/api/title/${type}/${id}/state`).catch(() => ({ status: null, rating: null })),
    ]);
    const facts = [];
    if (film.year) facts.push(`<b>${film.year}</b>`);
    if (film.runtime) facts.push(`${film.runtime} мин`);
    if (film.seasons) facts.push(`${film.seasons} сезон(ов)`);
    if (film.directors.length) facts.push('реж. <b>' + esc(film.directors.join(', ')) + '</b>');

    const pips = Array.from({ length: 10 }, (_, i) => i + 1).map((n) =>
      `<div class="pip ${state.rating >= n ? 'on' : ''}" data-n="${n}">${n}</div>`).join('');

    const statusBtn = (s, label) =>
      `<button class="btn sm ${state.status === s ? 'active' : ''}" onclick="App.setStatus('${type}',${id},'${s}',this)"
         data-title="${esc(film.title)}" data-poster="${esc(film.poster || '')}">${label}</button>`;

    app().innerHTML = `
      <div class="film-hero">
        ${film.backdrop ? `<div class="film-backdrop" style="background-image:url(${esc(film.backdrop)})"></div>` : ''}
        <div class="film-top">
          <div class="film-poster">
            ${film.poster ? `<img src="${esc(film.poster)}">` : '<div class="ph"></div>'}
          </div>
          <div class="film-info">
            <h1>${esc(film.title)}</h1>
            ${film.original_title && film.original_title !== film.title
              ? `<div class="orig">${esc(film.original_title)}</div>` : ''}
            ${film.tagline ? `<div class="tagline">${esc(film.tagline)}</div>` : ''}
            <div class="facts">${facts.join(' · ')}</div>
            <div class="genres">${film.genres.map((g) => `<span>${esc(g)}</span>`).join('')}</div>
            ${film.vote ? `<div class="score-badge"><b>${film.vote}</b> / 10 TMDB · ${film.vote_count} голосов</div>` : ''}
            <p class="overview">${esc(film.overview || 'Описание отсутствует.')}</p>

            <div class="film-actions">
              <a class="btn accent" href="/watch/${type}/${id}" target="_blank" rel="noopener">▶ Смотреть</a>
              ${statusBtn('watching', 'Смотрю')}
              ${statusBtn('watched', 'Просмотрено')}
              ${statusBtn('watchlist', 'Хочу посмотреть')}
              <button class="btn sm" onclick="App.addToListModal('${type}',${id},'${esc(film.title)}','${esc(film.poster || '')}')">＋ В список</button>
            </div>

            <label class="fl">Моя оценка</label>
            <div class="rate-row" id="rateRow">${pips}</div>
          </div>
        </div>
      </div>

      ${film.trailer ? `<div class="section">
        <div class="section-head"><h2>Трейлер</h2><span class="line"></span></div>
        <div class="trailer-wrap"><iframe src="${esc(film.trailer)}" allowfullscreen
          allow="accelerometer;encrypted-media;picture-in-picture"></iframe></div>
      </div>` : ''}

      ${film.cast.length ? `<div class="section">
        <div class="section-head"><h2>В ролях</h2><span class="line"></span></div>
        <div class="cast-row">${film.cast.map((c) => `
          <div class="cast-card">
            ${c.photo ? `<img src="${esc(c.photo)}">` : '<div class="ph"></div>'}
            <b>${esc(c.name)}</b><span>${esc(c.character || '')}</span>
          </div>`).join('')}</div>
      </div>` : ''}

      <div class="section">
        <div class="section-head"><h2>Рецензии</h2><span class="line"></span>
          <button class="btn sm accent" onclick="App.reviewModal('${type}',${id},'${esc(film.title)}','${esc(film.poster || '')}',${state.rating || 0})">
            ✍ Написать</button>
        </div>
        <div id="reviewList"></div>
      </div>

      ${film.recommendations.length ? `<div class="section">
        <div class="section-head"><h2>Похожее</h2><span class="line"></span></div>
        ${grid(film.recommendations)}
      </div>` : ''}`;

    // rating pips
    const row = $('#rateRow');
    row.querySelectorAll('.pip').forEach((p) => {
      p.onmouseenter = () => paintPips(row, +p.dataset.n);
      p.onclick = async () => {
        const n = +p.dataset.n;
        await api('/api/reviews', { method: 'POST', body: JSON.stringify({
          tmdb_id: +id, media_type: type, title: film.title, poster: film.poster, rating: n }) });
        toast('Оценка ' + n + '/10 сохранена');
        paintPips(row, n, true);
        loadReviews(type, id);
      };
    });
    row.onmouseleave = () => paintPips(row, state.rating || 0, true);

    renderReviews(revs.reviews);
    window._loadReviews = () => loadReviews(type, id);
  }

  function paintPips(row, n, lock) {
    row.querySelectorAll('.pip').forEach((p) => p.classList.toggle('on', +p.dataset.n <= n));
    if (lock) row._locked = n;
  }
  async function loadReviews(type, id) {
    const d = await api(`/api/reviews/${type}/${id}`);
    renderReviews(d.reviews);
  }
  function renderReviews(reviews) {
    const box = $('#reviewList');
    if (!reviews.length) { box.innerHTML = '<div class="empty">Пока нет рецензий — будьте первым.</div>'; return; }
    box.innerHTML = reviews.map((r) => {
      const mine = ME && r.user.username === ME.username;
      return `<div class="review" data-id="${r.id}">
        <div class="av" onclick="App.go('/user/${esc(r.user.username)}')">${avatar(r.user)}</div>
        <div class="body">
          <div class="who">
            <b onclick="App.go('/user/${esc(r.user.username)}')" style="cursor:pointer">${esc(r.user.display_name)}</b>
            ${r.rating ? `<span class="stars">${stars(r.rating)} ${r.rating}/10</span>` : ''}
            <span class="date">${ago(r.created_at)}</span>
          </div>
          ${r.text ? `<div class="text">${esc(r.text)}</div>` : ''}
          <div class="acts">
            <span onclick="App.toggleComments(${r.id})">💬 Комментарии</span>
            ${mine ? `<span onclick="App.deleteReview(${r.id})">Удалить</span>` : ''}
          </div>
          <div class="comments" id="comments-${r.id}" style="display:none"></div>
        </div>
      </div>`;
    }).join('');
  }

  async function toggleComments(reviewId) {
    const box = $('#comments-' + reviewId);
    if (box.style.display === 'block') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    const d = await api(`/api/reviews/${reviewId}/comments`);
    box.innerHTML = d.comments.map((c) => `
      <div class="comment"><div class="c-av">${avatar(c.user)}</div>
      <div><b>${esc(c.user.display_name)}</b> ${esc(c.text)}</div></div>`).join('') +
      `<div class="comment"><div class="c-av">${avatar(ME)}</div>
        <div style="flex:1;display:flex;gap:8px">
          <input type="text" id="ci-${reviewId}" placeholder="Ответить…" style="padding:7px 12px">
          <button class="btn sm" onclick="App.sendComment(${reviewId})">→</button>
        </div></div>`;
  }
  async function sendComment(reviewId) {
    const inp = $('#ci-' + reviewId); const text = inp.value.trim();
    if (!text) return;
    await api(`/api/reviews/${reviewId}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
    toggleComments(reviewId); toggleComments(reviewId);
  }
  async function deleteReview(id) {
    if (!confirm('Удалить рецензию?')) return;
    await api('/api/reviews/' + id, { method: 'DELETE' });
    window._loadReviews && window._loadReviews();
    toast('Удалено');
  }

  async function setStatus(type, id, status, btn) {
    const title = btn.dataset.title, poster = btn.dataset.poster;
    const isActive = btn.classList.contains('active');
    if (isActive) {
      await api(`/api/status/${type}/${id}`, { method: 'DELETE' });
      btn.classList.remove('active'); toast('Убрано');
    } else {
      await api('/api/status', { method: 'POST', body: JSON.stringify({
        tmdb_id: +id, media_type: type, status, title, poster }) });
      btn.parentElement.querySelectorAll('.btn.active').forEach((b) => {
        if (b !== btn && ['Смотрю','Просмотрено','Хочу посмотреть'].includes(b.textContent.trim()))
          b.classList.remove('active');
      });
      btn.classList.add('active'); toast('Сохранено');
    }
  }

  function reviewModal(type, id, title, poster, rating) {
    modal(`
      <h3>Рецензия</h3>
      <div class="sub">${esc(title)}</div>
      <label class="fl">Оценка</label>
      <div class="rate-row" id="mRate">${Array.from({length:10},(_,i)=>i+1).map(n=>
        `<div class="pip ${rating>=n?'on':''}" data-n="${n}">${n}</div>`).join('')}</div>
      <label class="fl">Дата просмотра</label>
      <input type="date" id="mDate" value="${new Date().toISOString().slice(0,10)}">
      <label class="fl">Текст рецензии</label>
      <textarea id="mText" rows="6" placeholder="Что вы думаете об этом?"></textarea>
      <div class="modal-actions">
        <button class="btn ghost" onclick="App.closeModal()">Отмена</button>
        <button class="btn accent" id="mSave">Опубликовать</button>
      </div>`);
    let chosen = rating || 0;
    const mr = $('#mRate');
    mr.querySelectorAll('.pip').forEach((p) => {
      p.onmouseenter = () => paintPips(mr, +p.dataset.n);
      p.onclick = () => { chosen = +p.dataset.n; paintPips(mr, chosen, true); };
    });
    mr.onmouseleave = () => paintPips(mr, chosen, true);
    $('#mSave').onclick = async () => {
      await api('/api/reviews', { method: 'POST', body: JSON.stringify({
        tmdb_id: +id, media_type: type, title, poster,
        rating: chosen || null, text: $('#mText').value.trim() || null,
        watched_on: $('#mDate').value }) });
      closeModal(); toast('Рецензия опубликована');
      window._loadReviews && window._loadReviews();
    };
  }

  async function addToListModal(type, id, title, poster) {
    const d = await api('/api/me/lists');
    const lists = d.lists;
    modal(`
      <h3>Добавить в список</h3>
      <div class="sub">${esc(title)}</div>
      ${lists.length ? lists.map((l) => `
        <button class="btn" style="width:100%;justify-content:space-between;margin-bottom:8px"
          onclick="App.addItemToList(${l.id},'${type}',${id},'${esc(title)}','${esc(poster)}')">
          <span>${esc(l.name)}</span><span style="color:var(--faint)">${l.count}</span></button>`).join('')
        : '<div class="empty">У вас пока нет списков.</div>'}
      <div class="modal-actions">
        <button class="btn ghost" onclick="App.closeModal()">Закрыть</button>
        <button class="btn accent" onclick="App.newListModal()">＋ Новый список</button>
      </div>`);
  }
  async function addItemToList(listId, type, id, title, poster) {
    await api(`/api/lists/${listId}/items`, { method: 'POST', body: JSON.stringify({
      tmdb_id: +id, media_type: type, title, poster }) });
    closeModal(); toast('Добавлено в список');
  }

  // ═══ PROFILE ════════════════════════════════════════════════════
  async function viewProfile(username) {
    app().innerHTML = '<div class="loader">Загрузка…</div>';
    const p = await api('/api/users/' + encodeURIComponent(username));
    const u = p.user;
    const favs = Array.from({ length: 4 }, (_, i) => p.favorites.find((f) => f.position === i) || null);

    const followBtn = p.is_me ? `<button class="btn" onclick="App.logout()">Выйти</button>` :
      (p.is_following
        ? `<button class="btn active" id="followBtn" onclick="App.unfollow(${u.id})">Вы подписаны</button>`
        : `<button class="btn accent" id="followBtn" onclick="App.follow(${u.id})">Подписаться</button>`);

    const dist = p.stats.distribution;
    const maxD = Math.max(1, ...Object.values(dist));

    app().innerHTML = `
      <div class="profile-head">
        <div class="pa">${avatar(u)}</div>
        <div style="flex:1">
          <h1>${esc(u.display_name)}</h1>
          <div class="handle">@${esc(u.username)} ·
            ${p.followers} подписчиков · ${p.following} подписок</div>
          <div class="bio" id="bioText">${esc(u.bio || (p.is_me ? 'Добавьте описание профиля…' : ''))}</div>
          ${p.is_me ? '<button class="btn ghost sm" style="margin-top:8px" onclick="App.editBio()">🖋 Изменить bio</button>' : ''}
        </div>
        <div>${followBtn}</div>
      </div>

      <div class="stat-row">
        <div class="stat"><b>${p.stats.watched}</b><span>Просмотрено</span></div>
        <div class="stat"><b>${p.stats.this_year}</b><span>В этом году</span></div>
        <div class="stat"><b>${p.stats.watchlist}</b><span>В планах</span></div>
        <div class="stat"><b>${p.stats.rated}</b><span>Оценок</span></div>
        <div class="stat"><b>${p.stats.avg_rating ?? '—'}</b><span>Средняя</span></div>
      </div>

      <div class="section">
        <div class="section-head"><h2>Любимые фильмы</h2><span class="line"></span></div>
        <div class="fav-grid">
          ${favs.map((f, i) => f
            ? `<div class="fav-slot" onclick="App.go('/film/${f.media_type}/${f.tmdb_id}')">
                 <img src="${esc(f.poster || '')}" alt="">
                 ${p.is_me ? `<div class="x" onclick="event.stopPropagation();App.removeFav(${i})">✕</div>` : ''}
               </div>`
            : `<div class="fav-slot" onclick="${p.is_me ? `App.pickFav(${i})` : ''}">${p.is_me ? '＋ Добавить' : '—'}</div>`
          ).join('')}
        </div>
      </div>

      <div class="section">
        <div class="section-head"><h2>Статистика оценок</h2><span class="line"></span></div>
        <div class="dist">${Object.keys(dist).map((k) =>
          `<div class="bar" title="${k}/10: ${dist[k]}" style="height:${(dist[k]/maxD)*100}%"></div>`).join('')}</div>
        <div class="dist-labels">${Object.keys(dist).map((k) => `<span>${k}</span>`).join('')}</div>
      </div>

      <div class="section">
        <div class="tabs" id="profTabs">
          <button class="active" data-tab="diary">Кинодневник</button>
          <button data-tab="watched">Просмотрено</button>
          <button data-tab="watching">Смотрю</button>
          <button data-tab="watchlist">Хочу посмотреть</button>
          <button data-tab="lists">Списки</button>
        </div>
        <div id="profBody"></div>
      </div>`;

    const tabs = $('#profTabs');
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      renderProfileTab(b.dataset.tab, p);
    });
    renderProfileTab('diary', p);
  }

  async function renderProfileTab(tab, p) {
    const body = $('#profBody');
    if (tab === 'diary') {
      if (!p.diary.length) { body.innerHTML = '<div class="empty">Дневник пуст.</div>'; return; }
      body.innerHTML = p.diary.map((r) => `
        <div class="review">
          <div class="poster" style="width:54px;aspect-ratio:2/3;flex:none"
            onclick="App.go('/film/${r.media_type}/${r.tmdb_id}')">
            ${r.poster ? `<img src="${esc(r.poster)}">` : '<div class="ph"></div>'}
          </div>
          <div class="body">
            <div class="who"><b style="cursor:pointer" onclick="App.go('/film/${r.media_type}/${r.tmdb_id}')">${esc(r.title || '')}</b>
              ${r.rating ? `<span class="stars">${stars(r.rating)} ${r.rating}/10</span>` : ''}
              <span class="date">${r.watched_on || ago(r.created_at)}</span></div>
            ${r.text ? `<div class="text">${esc(r.text)}</div>` : ''}
          </div>
        </div>`).join('');
      return;
    }
    if (tab === 'lists') {
      if (!p.lists.length) { body.innerHTML = '<div class="empty">Списков нет.</div>'; return; }
      body.innerHTML = p.lists.map((l) => `
        <div class="feed-item" style="cursor:pointer" onclick="App.go('/list/${l.id}')">
          <div class="ft"><b>${esc(l.name)}</b> <span class="when">· ${l.count} тайтлов</span>
          ${l.description ? `<div style="color:var(--muted)">${esc(l.description)}</div>` : ''}</div>
        </div>`).join('');
      return;
    }
    // collection tabs
    body.innerHTML = '<div class="loader">Загрузка…</div>';
    const d = await api(`/api/users/${encodeURIComponent(p.user.username)}/collection/${tab}`);
    if (!d.items.length) { body.innerHTML = '<div class="empty">Пусто.</div>'; return; }
    body.innerHTML = grid(d.items.map((x) => ({
      tmdb_id: x.tmdb_id, media_type: x.media_type, title: x.title, poster: x.poster })));
  }

  function editBio() {
    const cur = $('#bioText').textContent;
    modal(`<h3>Описание профиля</h3>
      <textarea id="bioInput" rows="4" maxlength="500">${esc(ME.bio || '')}</textarea>
      <div class="modal-actions">
        <button class="btn ghost" onclick="App.closeModal()">Отмена</button>
        <button class="btn accent" id="bioSave">Сохранить</button></div>`);
    $('#bioSave').onclick = async () => {
      const bio = $('#bioInput').value.trim();
      await api('/api/me/bio', { method: 'POST', body: JSON.stringify({ bio }) });
      ME.bio = bio; closeModal(); route();
    };
  }

  function pickFav(position) {
    modal(`<h3>Выбрать любимый фильм</h3>
      <input type="text" id="favSearch" placeholder="Поиск…" autocomplete="off">
      <div id="favResults" style="margin-top:12px"></div>
      <div class="modal-actions"><button class="btn ghost" onclick="App.closeModal()">Отмена</button></div>`);
    let t;
    $('#favSearch').addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = e.target.value.trim(); if (!q) return;
        const d = await api('/api/tmdb/search?q=' + encodeURIComponent(q));
        $('#favResults').innerHTML = d.results.slice(0, 6).map((x) => {
          const type = x.media_type === 'tv' ? 'tv' : 'movie';
          return `<div class="sr-item" onclick="App.setFav(${position},'${type}',${x.tmdb_id},'${esc(x.title)}','${esc(x.poster || '')}')">
            ${x.poster ? `<img src="${esc(x.poster)}">` : '<div class="sr-poster-fallback"></div>'}
            <div class="sr-meta"><b>${esc(x.title)}</b><span>${esc(x.year || '')}</span></div></div>`;
        }).join('');
      }, 280);
    });
  }
  async function setFav(position, type, id, title, poster) {
    await api('/api/me/favorites', { method: 'PUT', body: JSON.stringify({
      position, item: { tmdb_id: +id, media_type: type, title, poster } }) });
    closeModal(); toast('Добавлено'); route();
  }
  async function removeFav(position) {
    await api('/api/me/favorites', { method: 'PUT', body: JSON.stringify({ position, item: null }) });
    route();
  }

  async function follow(uid) { await api('/api/follow/' + uid, { method: 'POST' }); toast('Вы подписались'); route(); }
  async function unfollow(uid) { await api('/api/follow/' + uid, { method: 'DELETE' }); route(); }
  async function logout() { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; }

  // ═══ FEED ═══════════════════════════════════════════════════════
  async function viewFeed() {
    app().innerHTML = '<div class="loader">Загрузка…</div>';
    const d = await api('/api/feed');
    if (!d.feed.length) {
      app().innerHTML = `<div class="section"><div class="section-head"><h2>Лента</h2><span class="line"></span></div>
        <div class="empty">Пусто. Подпишитесь на других, чтобы видеть их активность.</div></div>`;
      return;
    }
    app().innerHTML = `<div class="section"><div class="section-head"><h2>Лента активности</h2><span class="line"></span></div>
      ${d.feed.map(feedItem).join('')}</div>`;
  }
  function feedItem(a) {
    const p = a.payload, u = a.user;
    const head = `<b style="cursor:pointer" onclick="App.go('/user/${esc(u.username)}')">${esc(u.display_name)}</b>`;
    let body = '', mini = '';
    if (p.poster) mini = `<img class="mini" src="${esc(p.poster)}"
      onclick="App.go('/film/${p.media_type}/${p.tmdb_id}')" style="cursor:pointer">`;
    if (a.type === 'review') body = `${head} ${p.rating ? `оценил${''} «${esc(p.title)}» на <span style="color:var(--accent)">${p.rating}/10</span>` : `написал рецензию на «${esc(p.title)}»`}${p.text ? `<div class="text" style="margin-top:6px;color:#d9d2c7">${esc(p.text)}</div>` : ''}`;
    else if (a.type === 'status') {
      const map = { watching: 'начал смотреть', watched: 'посмотрел', watchlist: 'добавил в планы' };
      body = `${head} ${map[p.status] || 'обновил'} «${esc(p.title || '')}»`;
    }
    else if (a.type === 'list') body = `${head} создал список «${esc(p.name)}»`;
    else if (a.type === 'follow') body = `${head} подписался на нового пользователя`;
    return `<div class="feed-item">
      <div class="fa" onclick="App.go('/user/${esc(u.username)}')" style="cursor:pointer">${avatar(u)}</div>
      <div class="ft">${body}<div class="when">${ago(a.created_at)}</div></div>
      ${mini}</div>`;
  }

  // ═══ LISTS ══════════════════════════════════════════════════════
  async function viewLists() {
    app().innerHTML = '<div class="loader">Загрузка…</div>';
    const d = await api('/api/me/lists');
    app().innerHTML = `<div class="section">
      <div class="section-head"><h2>Мои списки</h2><span class="line"></span>
        <button class="btn sm accent" onclick="App.newListModal()">＋ Новый список</button></div>
      ${d.lists.length ? d.lists.map((l) => `
        <div class="feed-item" style="cursor:pointer" onclick="App.go('/list/${l.id}')">
          <div class="ft"><b>${esc(l.name)}</b> <span class="when">· ${l.count} тайтлов</span>
          ${l.description ? `<div style="color:var(--muted)">${esc(l.description)}</div>` : ''}</div>
        </div>`).join('') : '<div class="empty">Создайте свой первый список.</div>'}
    </div>`;
  }
  function newListModal() {
    modal(`<h3>Новый список</h3>
      <label class="fl">Название</label><input type="text" id="lName" placeholder="Например: Нуары 70-х">
      <label class="fl">Описание</label><textarea id="lDesc" rows="3"></textarea>
      <div class="modal-actions"><button class="btn ghost" onclick="App.closeModal()">Отмена</button>
        <button class="btn accent" id="lSave">Создать</button></div>`);
    $('#lSave').onclick = async () => {
      const name = $('#lName').value.trim(); if (!name) return toast('Введите название');
      const d = await api('/api/lists', { method: 'POST', body: JSON.stringify({
        name, description: $('#lDesc').value.trim() }) });
      closeModal(); go('/list/' + d.id);
    };
  }
  async function viewList(id) {
    app().innerHTML = '<div class="loader">Загрузка…</div>';
    const d = await api('/api/lists/' + id);
    const mine = ME && d.list.user_id === ME.id;
    app().innerHTML = `<div class="section">
      <div class="section-head"><h2>${esc(d.list.name)}</h2><span class="line"></span>
        ${mine ? `<button class="btn sm danger" onclick="App.deleteList(${id})">🗑 Удалить</button>` : ''}</div>
      <p style="color:var(--muted);margin-bottom:20px">от
        <a href="#/user/${esc(d.list.username)}" style="color:var(--accent)">${esc(d.list.display_name)}</a>
        ${d.list.description ? '· ' + esc(d.list.description) : ''}</p>
      ${d.items.length ? grid(d.items.map((x) => ({
        tmdb_id: x.tmdb_id, media_type: x.media_type, title: x.title, poster: x.poster })))
        : '<div class="empty">Список пуст. Откройте фильм и нажмите «＋ В список».</div>'}
    </div>`;
  }
  async function deleteList(id) {
    if (!confirm('Удалить список?')) return;
    await api('/api/lists/' + id, { method: 'DELETE' });
    go('/lists');
  }

  // ── boot ────────────────────────────────────────────────────────
  async function init() {
    try {
      const d = await api('/api/me');
      ME = d.user;
    } catch { return; } // api() already redirected
    renderHeader();
    initSearch();
    window.addEventListener('hashchange', route);
    route();
  }

  return {
    init, go, route, closeModal,
    pickSearch, randomFilm,
    setStatus, reviewModal, deleteReview, toggleComments, sendComment,
    addToListModal, addItemToList, newListModal, deleteList,
    editBio, pickFav, setFav, removeFav, follow, unfollow, logout,
  };
})();

App.init();
