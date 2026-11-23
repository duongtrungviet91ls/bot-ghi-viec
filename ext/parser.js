// Bộ đọc bài báo — dùng chung cho extension. Hỗ trợ 3 nguồn (kiểm chứng trên bài mẫu 15–18/11/2026):
// - Báo Lạng Sơn (baolangson.vn): thân bài trong #content-detail; ảnh <figure><img><figcaption>;
//   đoạn sapo là khối <p> hoặc <h2> chứa img logo class "table-sapo-logo" (+ dấu "- " ở đầu): chữ của nó (sau
//   khi gỡ logo và dấu "-") là TÓM TẮT, và đoạn sapo được GỠ khỏi thân bài — thân bài chỉ gồm
//   các mục nằm dưới sapo, không lặp lại sapo ở đầu (quy tắc Duong chốt 16/11);
//   tên tác giả ở <div class="pseudonym"> cuối bài (thường viết HOA).
// - Báo Đại Đoàn Kết (daidoanket.vn): thân bài trong #content_article; tóm tắt ở
//   .article-content__description; tác giả ở phần tử .icon_author; ảnh dạng
//   <a href="link ảnh lớn"><figure><picture><img></picture><figcaption></figure></a> — phải gỡ lớp <a>
//   và làm phẳng <picture> trước khi chuyển đổi.
// - Báo Dân Trí (dantri.com.vn): thân bài trong div#desktop-cate-in-article (con của <article>);
//   tóm tắt là thẻ <h2> con trực tiếp của <article> (nằm ngoài khối thân), mở đầu bằng "(Dân trí) - "
//   phải cắt bỏ tiền tố đó; tác giả lấy từ JSON-LD (NewsArticle > author.name), dự phòng link
//   a[rel="author"]; ảnh <figure class="image"> có src là ẢNH GIỮ CHỖ dạng SVG (data:), link ảnh
//   thật nằm ở data-original (bản gốc) / data-src (bản thu nhỏ) — phải đổi src trước khi xử lý;
//   trong thân có widget .dantri-widget cần gỡ.
(function () {
  function absUrl(src, base) {
    try { return new URL(src, base).href; } catch (e) { return src; }
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function titleCaseVi(s) {
    // "THÁI SƠN" -> "Thái Sơn"; giữ nguyên nếu không phải viết hoa toàn bộ
    if (s !== s.toUpperCase() || s === s.toLowerCase()) return s;
    return s.toLowerCase().replace(/(^|\s)(\S)/g, (m, p1, p2) => p1 + p2.toUpperCase());
  }
  function stripLeadingDash(p) {
    // Bỏ dấu "- " ở đầu đoạn sapo (sau khi đã gỡ img logo)
    const walker = p.ownerDocument.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue.trim() === '') continue;
      n.nodeValue = n.nodeValue.replace(/^\s*[-–—]\s*/, '');
      break;
    }
  }

  // Pipeline chung cho mọi nguồn: gỡ rác -> chuyển figure thành đoạn ảnh căn giữa + chú thích căn giữa
  // -> bọc ảnh lẻ -> làm sạch thuộc tính -> bỏ đoạn rỗng -> ghi nguồn cuối bài.
  // (Dòng "Nguồn: ..." từng bỏ ở v2.28, Duong chốt chiều 16/11: lấy lại như v2.27.)
  function noRefAttr(src) {
    // CDN ảnh của Dân Trí (cdnphoto.dantri.com.vn) chặn tải ảnh theo địa chỉ trang hiển thị
    // (referer): ảnh nhúng trên trang khác miền bị trả 403 — đã kiểm chứng 18/11: không referer
    // hoặc referer dantri.com.vn thì 200, referer cổng MTTQ/Zalo OA thì 403. Gắn
    // referrerpolicy="no-referrer" để trình duyệt không gửi referer khi tải ảnh → qua chốt chặn.
    return /dantri\.com\.vn/i.test(src || '') ? ' referrerpolicy="no-referrer"' : '';
  }
  function realImgSrc(img) {
    // Link ảnh THẬT của một <img>: nếu src là ảnh giữ chỗ dạng data: (Dân Trí dùng SVG xám),
    // link thật nằm ở data-original (bản gốc, ưu tiên) hoặc data-src (bản thu nhỏ).
    const src = img.getAttribute('src') || '';
    if (src && src.indexOf('data:') !== 0) return src;
    return img.getAttribute('data-original') || img.getAttribute('data-src') || src;
  }
  function buildBody(holder, doc, pageUrl, creditName) {
    // Gỡ phần tử rác
    holder.querySelectorAll('script, style, iframe, noscript, .pseudonym, .relates, .topics, [class*="ads"], [id*="ads"]').forEach(el => el.remove());

    // Chuyển figure -> đoạn ảnh căn giữa + đoạn chú thích căn giữa
    const images = [];
    holder.querySelectorAll('figure').forEach(fig => {
      const img = fig.querySelector('img');
      const capEl = fig.querySelector('figcaption');
      const cap = capEl ? capEl.textContent.replace(/\s+/g, ' ').trim() : '';
      const src = img ? absUrl(realImgSrc(img), pageUrl) : '';
      let html = '';
      if (src) {
        images.push(src);
        html += '<p style="text-align: center;"><img src="' + esc(src) + '"' + noRefAttr(src) + ' alt="" style="max-width: 100%; height: auto;" /></p>';
      }
      if (cap) html += '<p style="text-align: center;">' + esc(cap) + '</p>';
      const tmp = doc.createElement('div');
      tmp.innerHTML = html;
      fig.replaceWith(...Array.from(tmp.childNodes));
    });

    // Ảnh lẻ không nằm trong figure -> bọc vào đoạn căn giữa
    holder.querySelectorAll('img').forEach(img => {
      if (img.closest('p') && img.parentElement.textContent.trim() === '') {
        img.parentElement.style.textAlign = 'center';
        return;
      }
      const src = absUrl(realImgSrc(img), pageUrl);
      if (!src) { img.remove(); return; }
      if (!images.includes(src)) images.push(src);
      const p = doc.createElement('p');
      p.setAttribute('style', 'text-align: center;');
      const ni = doc.createElement('img');
      ni.setAttribute('src', src);
      if (noRefAttr(src)) ni.setAttribute('referrerpolicy', 'no-referrer');
      ni.setAttribute('style', 'max-width: 100%; height: auto;');
      p.appendChild(ni);
      img.replaceWith(p);
    });

    // Làm sạch thuộc tính: bỏ class/id/data-*, giữ style căn lề và href của <a>
    holder.querySelectorAll('*').forEach(el => {
      Array.from(el.attributes || []).forEach(attr => {
        if (attr.name === 'style') {
          const m = /text-align\s*:\s*(center|justify|left|right)/i.exec(attr.value || '');
          if (m && !(el.tagName === 'IMG')) el.setAttribute('style', 'text-align: ' + m[1].toLowerCase() + ';');
          else if (el.tagName !== 'IMG') el.removeAttribute('style');
        } else if (attr.name === 'href' && el.tagName === 'A') {
          el.setAttribute('href', absUrl(attr.value, pageUrl));
        } else if (attr.name === 'src' && el.tagName === 'IMG') {
          // giữ nguyên
        } else if (attr.name === 'alt' && el.tagName === 'IMG') {
          // giữ nguyên
        } else if (attr.name === 'referrerpolicy' && el.tagName === 'IMG') {
          // giữ nguyên — thuộc tính chống chặn referer cho ảnh Dân Trí (xem noRefAttr)
        } else {
          el.removeAttribute(attr.name);
        }
      });
    });

    // Bỏ đoạn rỗng (không chữ, không ảnh)
    holder.querySelectorAll('p, div').forEach(el => {
      if (!el.querySelector('img') && el.textContent.trim() === '') el.remove();
    });

    let bodyHtml = holder.innerHTML.trim();
    // Ghi nguồn cuối bài (đúng thói quen các bài đã đăng)
    bodyHtml += '<p><em>Nguồn: <a href="' + esc(pageUrl) + '">' + esc(creditName) + '</a></em></p>';
    return { bodyHtml: bodyHtml, images: images };
  }

  function getTitle(doc) {
    const h1 = doc.querySelector('h1');
    let title = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '';
    if (!title) {
      const og = doc.querySelector('meta[property="og:title"]');
      if (og) title = (og.getAttribute('content') || '').replace(/\s*-\s*Báo.*$/, '').trim();
    }
    if (!title) throw new Error('Không tìm thấy tiêu đề bài báo.');
    return title;
  }

  function parseBaoLangSon(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = getTitle(doc);

    const pseudo = doc.querySelector('.pseudonym');
    const author = pseudo ? titleCaseVi(pseudo.textContent.replace(/\s+/g, ' ').trim()) : '';

    const root = doc.querySelector('#content-detail');
    if (!root) throw new Error('Không tìm thấy khối nội dung #content-detail trong bài nguồn.');

    // Vùng làm việc: div con trực tiếp của #content-detail (nếu có)
    const holder = doc.createElement('div');
    holder.innerHTML = (root.firstElementChild ? root.firstElementChild.innerHTML : root.innerHTML);

    // Gỡ rác trước để đoạn sapo tìm được đúng <p> nội dung đầu tiên
    holder.querySelectorAll('script, style, iframe, noscript, .pseudonym, .relates, .topics, [class*="ads"], [id*="ads"]').forEach(el => el.remove());

    // Đoạn sapo = KHỐI chứa img logo "table-sapo-logo". Khối đó thường là <p> (bài Đình Lập,
    // Hồng Phong, Lùng Pa) nhưng cũng có bài để sapo trong <h2> (bài "Ngày cuối tuần cùng
    // nông dân" 5108261 — bản v2.26 chỉ tìm trong <p> nên nhận nhầm đoạn thân đầu tiên làm
    // tóm tắt, còn sapo thật kẹt lại ở đầu thân bài). Dự phòng khi không có logo: <p> đầu
    // tiên có chữ. Tóm tắt = chữ của sapo sau khi gỡ logo và bỏ "- " ở đầu (chính là phần
    // chữ sau tiền tố địa danh kiểu "Lạng Sơn - " trên mặt báo). Sau khi lấy tóm tắt phải
    // GỠ HẲN khối sapo khỏi thân bài: nội dung chỉ gồm các mục nằm DƯỚI sapo (v2.26).
    let sapoText = '';
    let sapoEl = null;
    const logoImg = holder.querySelector('img.table-sapo-logo');
    if (logoImg) {
      sapoEl = logoImg.closest('p, h2, h3, h4, blockquote, li');
      if (!sapoEl) {
        // Logo nằm trực tiếp trong một div: chỉ nhận khi div đó ngắn như một đoạn sapo
        const par = logoImg.parentElement;
        if (par && par.textContent.replace(/\s+/g, ' ').trim().length <= 800 && !par.querySelector('p, figure')) sapoEl = par;
      }
    }
    if (!sapoEl) sapoEl = Array.from(holder.querySelectorAll('p')).find(p => p.textContent.trim().length > 0) || null;
    if (sapoEl) {
      sapoEl.querySelectorAll('img.table-sapo-logo').forEach(el => el.remove());
      stripLeadingDash(sapoEl);
      sapoText = sapoEl.textContent.replace(/\s+/g, ' ').trim();
      sapoEl.remove();
    }
    // Gỡ logo sapo ở mọi vị trí còn sót
    holder.querySelectorAll('img.table-sapo-logo').forEach(el => el.remove());

    const built = buildBody(holder, doc, pageUrl, 'Báo Lạng Sơn');
    return {
      title: title,
      author: author,
      summaryText: sapoText,
      bodyHtml: built.bodyHtml,
      images: built.images,
      firstImage: built.images.length ? built.images[0] : ''
    };
  }

  function parseDaiDoanKet(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = getTitle(doc);

    const authEl = doc.querySelector('.icon_author');
    const author = authEl ? titleCaseVi(authEl.textContent.replace(/\s+/g, ' ').trim()) : '';

    const root = doc.querySelector('#content_article');
    if (!root) throw new Error('Không tìm thấy khối nội dung #content_article trong bài nguồn.');

    const holder = doc.createElement('div');
    holder.innerHTML = root.innerHTML;

    // Gỡ lớp <a> bọc ảnh (href trỏ thẳng tới file ảnh lớn) để ảnh không biến thành link,
    // và làm phẳng <picture> về <img> thường trước khi chạy pipeline chung
    holder.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href') || '';
      // Link ảnh lớn của trang này có dạng "...jpg.avif" nên chỉ cần href chứa đuôi ảnh là nhận diện được
      if (/\.(jpe?g|png|webp|gif|avif)/i.test(href) && a.querySelector('img, figure, picture')) {
        a.replaceWith(...Array.from(a.childNodes));
      }
    });
    holder.querySelectorAll('picture').forEach(pic => {
      const img = pic.querySelector('img');
      if (img) pic.replaceWith(img); else pic.remove();
    });

    // Tóm tắt = đoạn mô tả riêng của bài (nằm NGOÀI thân bài nên không bị lặp);
    // thiếu thì lấy đoạn đầu thân bài làm tóm tắt và gỡ đoạn đó khỏi thân (cùng quy tắc
    // như Báo Lạng Sơn: thân bài không lặp lại đoạn tóm tắt)
    const desc = doc.querySelector('.article-content__description');
    let summaryText = desc ? desc.textContent.replace(/\s+/g, ' ').trim() : '';
    if (!summaryText) {
      const firstP = Array.from(holder.querySelectorAll('p')).find(p => p.textContent.trim().length > 0);
      if (firstP) { summaryText = firstP.textContent.replace(/\s+/g, ' ').trim(); firstP.remove(); }
    }

    const built = buildBody(holder, doc, pageUrl, 'Báo Đại Đoàn Kết');
    return {
      title: title,
      author: author,
      summaryText: summaryText,
      bodyHtml: built.bodyHtml,
      images: built.images,
      firstImage: built.images.length ? built.images[0] : ''
    };
  }

  function parseDanTri(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = getTitle(doc);

    // Tác giả: ưu tiên dữ liệu cấu trúc JSON-LD (NewsArticle > author.name — neo ổn định nhất);
    // dự phòng: link tác giả rel="author" (href chứa /tac-gia/) ở dòng byline đầu bài
    let author = '';
    try {
      const blocks = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
      for (const b of blocks) {
        const j = JSON.parse(b.textContent);
        const items = Array.isArray(j) ? j : [j];
        const art = items.find(x => x && (x['@type'] === 'NewsArticle' || x.headline));
        if (art && art.author) {
          const a0 = Array.isArray(art.author) ? art.author[0] : art.author;
          author = (a0 && a0.name) || '';
          if (author) break;
        }
      }
    } catch (e) {}
    if (!author) {
      const a = doc.querySelector('a[rel="author"], a[href*="/tac-gia/"]');
      if (a) author = a.textContent.replace(/\s+/g, ' ').trim();
    }
    author = titleCaseVi(author.replace(/\s+/g, ' ').trim());

    // Thân bài: div#desktop-cate-in-article; dự phòng: khối con của <article> có nhiều <p> nhất
    let root = doc.getElementById('desktop-cate-in-article');
    if (!root) {
      const artEl0 = doc.querySelector('article');
      if (artEl0) root = Array.from(artEl0.children).sort((x, y) => y.querySelectorAll('p').length - x.querySelectorAll('p').length)[0] || null;
    }
    if (!root) throw new Error('Không tìm thấy khối nội dung bài Dân Trí (desktop-cate-in-article).');

    const holder = doc.createElement('div');
    holder.innerHTML = root.innerHTML;

    // Ảnh Dân Trí: src là ảnh giữ chỗ SVG (data:), link thật ở data-original — chuẩn hoá ngay từ đầu
    // để mọi nhánh xử lý (kể cả ảnh nằm yên trong <p>) đều thấy link thật
    holder.querySelectorAll('img').forEach(img => {
      const s = img.getAttribute('src') || '';
      if (!s || s.indexOf('data:') === 0) {
        const real = img.getAttribute('data-original') || img.getAttribute('data-src');
        if (real) img.setAttribute('src', real);
      }
      // Kèm thuộc tính chống chặn referer ngay trên thẻ gốc — nhánh "ảnh nằm yên trong <p>"
      // của buildBody giữ nguyên thẻ này thay vì dựng thẻ mới
      if (/dantri\.com\.vn/i.test(img.getAttribute('src') || '')) img.setAttribute('referrerpolicy', 'no-referrer');
    });
    // Gỡ widget (hộp quyên góp .dantri-widget nằm cuối thân, không phải nội dung bài)
    holder.querySelectorAll('.dantri-widget').forEach(el => el.remove());

    // Tóm tắt = thẻ <h2> con trực tiếp của <article> (sapo, nằm NGOÀI khối thân nên không trùng thân),
    // cắt bỏ tiền tố "(Dân trí) - " ở đầu. Thiếu sapo mới lấy đoạn đầu của thân (và gỡ đoạn đó khỏi thân).
    let summaryText = '';
    const artEl = doc.querySelector('article');
    const sapo = artEl ? artEl.querySelector(':scope > h2') : doc.querySelector('h2');
    if (sapo) summaryText = sapo.textContent.replace(/\s+/g, ' ').trim().replace(/^\(Dân trí\)\s*[-–—]\s*/i, '');
    if (!summaryText) {
      const firstP = Array.from(holder.querySelectorAll('p')).find(p => p.textContent.trim().length > 0);
      if (firstP) { summaryText = firstP.textContent.replace(/\s+/g, ' ').trim(); firstP.remove(); }
    }

    const built = buildBody(holder, doc, pageUrl, 'Báo Dân Trí');
    return {
      title: title,
      author: author,
      summaryText: summaryText,
      bodyHtml: built.bodyHtml,
      images: built.images,
      firstImage: built.images.length ? built.images[0] : ''
    };
  }

  // Chọn bộ đọc theo tên miền của link nguồn
  function parseArticle(html, pageUrl) {
    if (/daidoanket\.vn/i.test(pageUrl || '')) return parseDaiDoanKet(html, pageUrl);
    if (/dantri\.com\.vn/i.test(pageUrl || '')) return parseDanTri(html, pageUrl);
    return parseBaoLangSon(html, pageUrl);
  }

  function slugifyVi(s) {
    const map = { 'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a', 'ă': 'a', 'ằ': 'a', 'ắ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a', 'â': 'a', 'ầ': 'a', 'ấ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a', 'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e', 'ê': 'e', 'ề': 'e', 'ế': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e', 'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i', 'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o', 'ô': 'o', 'ồ': 'o', 'ố': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o', 'ơ': 'o', 'ờ': 'o', 'ớ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o', 'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u', 'ư': 'u', 'ừ': 'u', 'ứ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u', 'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y', 'đ': 'd' };
    return s.toLowerCase().split('').map(c => map[c] || c).join('')
      .replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  }

  window.MTTQParser = { parseBaoLangSon: parseBaoLangSon, parseDaiDoanKet: parseDaiDoanKet, parseDanTri: parseDanTri, parseArticle: parseArticle, slugifyVi: slugifyVi };
})();
