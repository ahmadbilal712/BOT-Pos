/* bot_pos: POS Item Selector Override (no-bundle, easy mode)
   - Overrides class AND replaces the live instance on the POS page
   - Safe onScan handling (no double attach)
*/

(() => {
	console.log("[bot_pos] POS override script loaded (easy mode)");

	// Wait until ERPNext POS code is ready
	const waitForPOS = (cb) => {
		const t = setInterval(() => {
			if (window.erpnext && erpnext.PointOfSale) {
				clearInterval(t);
				cb();
			}
		}, 60);
	};

	waitForPOS(defineAndReplace);

	function defineAndReplace() {
		// --- 1) Define override class ---
		erpnext.PointOfSale.ItemSelector = class {
			constructor({ frm, wrapper, events, pos_profile, settings }) {
				this.wrapper = wrapper;
				this.events = events;
				this.pos_profile = pos_profile;
				this.hide_images = settings.hide_images;
				this.auto_add_item = settings.auto_add_item_to_cart;

				// guards + helpers
				this.nav_stack = [];
				this.current_group = null;
				this._groups_token = 0; // prevent double render
				this._t = (s) => (typeof __ === "function" ? __(s) : s);

				// caches
				this._group_meta_cache = new Map();   // name -> {lft, rgt, is_group}
				this._count_cache = new Map();        // name -> item_count

				this.inti_component();
			}

			inti_component() {
				this.prepare_dom();
				this.make_search_bar();
				this.load_items_data();
				this.bind_events();
				this.attach_shortcuts();
			}

			prepare_dom() {
				// avoid duplicate mounts if wrapper reused
				this.wrapper.find(".items-selector").remove();

				this.wrapper.append(
					`<section class="items-selector">
						<div class="filter-section">
							<div class="label breadcrumb-label">${this._t("All Items")}</div>
							<div class="search-field"></div>
							<div class="item-group-field"></div>
						</div>
						<div class="items-container"></div>
					</section>`
				);

				this.$component = this.wrapper.find(".items-selector");
				this.$items_container = this.$component.find(".items-container");
				this.$breadcrumb = this.$component.find(".breadcrumb-label");
			}

			// ---------- DATA BOOTSTRAP ----------
			async load_items_data() {
				// parent item group used by POS (kept from core behavior)
				if (!this.parent_item_group) {
					await frappe.call({
						method: "erpnext.selling.page.point_of_sale.point_of_sale.get_parent_item_group",
						callback: (r) => r.message && (this.parent_item_group = r.message),
						async: false
					});
				}

				if (!this.price_list) {
					const res = await frappe.db.get_value(
						"POS Profile",
						this.pos_profile,
						"selling_price_list"
					);
					this.price_list = res.message.selling_price_list;
				}

				// read allowed roots from POS Profile Filters → Item Groups
				this.allowed_roots = await this.get_allowed_root_groups();

				// show groups from allowed roots only
				this.show_root();
			}

			// read POS Profile child table "item_groups" (field: item_group)
			async get_allowed_root_groups() {
				const prof = await frappe.call({
					method: "frappe.client.get",
					args: { doctype: "POS Profile", name: this.pos_profile }
				});
				const doc = prof.message || {};
				const rows = (doc.item_groups || []).map(r => r.item_group).filter(Boolean);

				// If nothing configured, fall back to POS parent group
				if (!rows.length) return [this.parent_item_group];

				// De-duplicate and keep order
				const seen = new Set();
				return rows.filter(n => !seen.has(n) && seen.add(n));
			}

			// ---------- ROOT RENDER ----------
			async show_root() {
				const token = ++this._groups_token;
				this.$items_container.html("");
				this.current_group = null;
				this.set_breadcrumb();

				// Multiple roots (e.g., Safwa Items + Aziziyah Items)
				if (this.allowed_roots.length > 1) {
					let shown = 0; // how many cards rendered

					for (const root of this.allowed_roots) {
						if (token !== this._groups_token) return;

						const meta = await this.get_group_meta(root); // {is_group, lft, rgt}
						const count = await this.get_item_count_for_group(root, meta);
						if (token !== this._groups_token) return;

						// skip zero-count roots
						if (!count) continue;

						const card = this.make_group_card(root, !!meta.is_group, count);
						card.on("click", () => {
							this.nav_stack.push({ type: "root" });
							this.show_groups(root);
						});
						this.$items_container.append(card);
						shown++;
					}

					if (!shown) {
						this.$items_container.append(
							`<div class="text-muted" style="margin-top:10px">${this._t("No categories with items.")}</div>`
						);
					}
					return;
				}

				// Single allowed root → jump into it
				await this.show_groups(this.allowed_roots[0]);
			}

			// ---------- GROUP BROWSER ----------
			async show_groups(parent_group_name) {
				const token = ++this._groups_token;

				this.$items_container.html("");
				this.current_group = parent_group_name;
				this.set_breadcrumb();

				// Back button
				if (this.nav_stack.length) {
					const back_btn = $(
						`<button class="btn btn-default" style="margin-bottom:10px;">⬅ ${this._t("Back")}</button>`
					);
					back_btn.on("click", () => this.go_back());
					this.$items_container.append(back_btn);
				}

				// fetch direct children
				const groups_res = await frappe.call({
					method: "frappe.client.get_list",
					args: {
						doctype: "Item Group",
						fields: ["name", "is_group", "lft", "rgt"],
						filters: { parent_item_group: parent_group_name },
						order_by: "idx asc, name asc",
						limit_page_length: 1000
					}
				});
				if (token !== this._groups_token) return;

				const groups = (groups_res.message || []).map(g => {
					this._group_meta_cache.set(g.name, { is_group: g.is_group, lft: g.lft, rgt: g.rgt });
					return g;
				});

				let shown = 0;

				for (const g of groups) {
					const count = await this.get_item_count_for_group(g.name, g);
					if (token !== this._groups_token) return;

					// skip zero-count child groups/categories
					if (!count) continue;

					const card = this.make_group_card(g.name, !!g.is_group, count);
					card.on("click", () => this.on_group_click(g));
					this.$items_container.append(card);
					shown++;
				}

				if (!shown) {
					this.$items_container.append(
						`<div class="text-muted" style="margin-top:10px">${this._t("No categories with items here.")}</div>`
					);
				}
			}

			async on_group_click(group) {
				// Folder → drill down
				if (group.is_group) {
					this.nav_stack.push({ type: "groups", parent: this.current_group });
					return this.show_groups(group.name);
				}

				// Leaf → load items of this group (server respects POS Profile)
				this.nav_stack.push({ type: "groups", parent: this.current_group });
				this.item_group = group.name;
				const { message } = await this.get_items({});
				this.render_item_list(message.items, /* from_category */ true);
			}

			go_back() {
				const last = this.nav_stack.pop();
				if (!last) return this.show_root();
				if (last.type === "root") return this.show_root();
				if (last.type === "groups") return this.show_groups(last.parent);
				return this.show_root();
			}

			set_breadcrumb() {
				const parts = [this._t("All Items")];
				if (this.current_group) parts.push("› " + this.current_group);
				this.$breadcrumb.text(parts.join(" "));
			}

			// ---------- ITEM COUNTS ----------
			async get_group_meta(name) {
				if (this._group_meta_cache.has(name)) return this._group_meta_cache.get(name);
				const resp = await frappe.db.get_value("Item Group", name, ["is_group", "lft", "rgt"]);
				const meta = {
					is_group: resp.message.is_group,
					lft: resp.message.lft,
					rgt: resp.message.rgt
				};
				this._group_meta_cache.set(name, meta);
				return meta;
			}

			// Count ALL items inside the subtree of a group (leaf or folder).
			async get_item_count_for_group(group_name, metaMaybe) {
				if (this._count_cache.has(group_name)) return this._count_cache.get(group_name);

				const meta = metaMaybe || (await this.get_group_meta(group_name));

				// get all leaf item groups within lft..rgt (including the leaf itself)
				const leaves = await frappe.call({
					method: "frappe.client.get_list",
					args: {
						doctype: "Item Group",
						fields: ["name"],
						filters: { lft: [">=", meta.lft], rgt: ["<=", meta.rgt], is_group: 0 },
						limit_page_length: 10000
					}
				});
				const leaf_names = (leaves.message || []).map(r => r.name);
				if (!leaf_names.length) {
					this._count_cache.set(group_name, 0);
					return 0;
				}

				// count Items where item_group in leaf_names
				const cnt = await frappe.call({
					method: "frappe.client.get_count",
					args: { doctype: "Item", filters: { item_group: ["in", leaf_names] } }
				});
				const n = cnt.message || 0;
				this._count_cache.set(group_name, n);
				return n;
			}

			// ---------- GROUP CARD ----------
			make_group_card(name, is_folder, badge) {
				const emoji = is_folder ? "📂" : "📦";
				return $(`<div class="category-card"
						style="width:165px; height:110px; border:1px solid #e5e7eb;
							display:flex; flex-direction:column; align-items:center;
							justify-content:center; cursor:pointer; border-radius:10px;
							margin:10px; position:relative; background:#f9fafb;">
						<span style="font-size:20px;margin-bottom:6px">${emoji}</span>
						<span style="font-weight:600;text-align:center;padding:0 8px">${frappe.utils.escape_html(name)}</span>
						<span style="position:absolute; top:6px; right:8px;
							background:#2563eb; color:#fff; font-size:12px;
							padding:2px 8px; border-radius:20px;">${badge}</span>
					</div>`);
			}

			// ---------- ITEMS ----------
			get_items({ start = 0, page_length = 40, search_term = "" }) {
				const doc = this.events.get_frm().doc;
				const price_list = (doc && doc.selling_price_list) || this.price_list;

				let { item_group, pos_profile } = this;
				!item_group && (item_group = this.parent_item_group);

				return frappe.call({
					method: "erpnext.selling.page.point_of_sale.point_of_sale.get_items",
					freeze: true,
					args: { start, page_length, price_list, item_group, search_term, pos_profile },
				});
			}

			render_item_list(items, from_category = false) {
				this.$items_container.html("");

				// Back to groups
				if (from_category || this.nav_stack.length) {
					const back_btn = $(`<button class="btn btn-default" style="margin-bottom:10px;">⬅ ${this._t("Back to Groups")}</button>`);
					back_btn.on("click", () => this.go_back());
					this.$items_container.append(back_btn);
				}

				if (!items || !items.length) {
					this.$items_container.append(`<div class="text-muted">${this._t("No items found.")}</div>`);
					return;
				}

				items.forEach((item) => {
					const item_html = this.get_item_html(item);
					this.$items_container.append(item_html);
				});
			}

			get_item_html(item) {
				const me = this;
				const { item_image, serial_no, batch_no, barcode, actual_qty, uom, price_list_rate } = item;
				const precision = flt(price_list_rate, 2) % 1 != 0 ? 2 : 0;
				let indicator_color;
				let qty_to_display = actual_qty;

				if (item.is_stock_item) {
					indicator_color = actual_qty > 10 ? "green" : actual_qty <= 0 ? "red" : "orange";
					if (Math.round(qty_to_display) > 999) {
						qty_to_display = (Math.round(qty_to_display) / 1000).toFixed(1) + "K";
					}
				} else {
					indicator_color = "";
					qty_to_display = "";
				}

				function get_item_image_html() {
					if (!me.hide_images && item_image) {
						return `<div class="item-qty-pill">
									<span class="indicator-pill whitespace-nowrap ${indicator_color}">${qty_to_display}</span>
								</div>
								<div class="flex items-center justify-center border-b-grey text-6xl text-grey-100" style="height:8rem; min-height:8rem">
									<img onerror="cur_pos.item_selector.handle_broken_image(this)"
										class="h-full item-img" src="${item_image}"
										alt="${frappe.get_abbr(item.item_name)}">
								</div>`;
					} else {
						return `<div class="item-qty-pill">
									<span class="indicator-pill whitespace-nowrap ${indicator_color}">${qty_to_display}</span>
								</div>
								<div class="item-display abbr">${frappe.get_abbr(item.item_name)}</div>`;
					}
				}

				return `<div class="item-wrapper"
					data-item-code="${escape(item.item_code)}" data-serial-no="${escape(serial_no)}"
					data-batch-no="${escape(batch_no)}" data-uom="${escape(uom)}"
					data-rate="${escape(price_list_rate || 0)}" data-stock-uom="${escape(item.stock_uom)}"
					title="${frappe.utils.escape_html(item.item_name)}">

					${get_item_image_html()}

					<div class="item-detail">
						<div class="item-name">${frappe.ellipsis(item.item_name, 18)}</div>
						<div class="item-rate">${format_currency(price_list_rate, item.currency, precision) || 0} / ${uom}</div>
					</div>
				</div>`;
			}

			handle_broken_image($img) {
				const item_abbr = $($img).attr("alt");
				$($img).parent().replaceWith(`<div class="item-display abbr">${item_abbr}</div>`);
			}

			// ---------- SEARCH + EVENTS ----------
			make_search_bar() {
				this.$component.find(".search-field").html("");
				this.$component.find(".item-group-field").html("");

				this.search_field = frappe.ui.form.make_control({
					df: {
						label: this._t("Search"),
						fieldtype: "Data",
						placeholder: this._t("Search by item code, serial number or barcode"),
						description: "" // prevent stray 'undefined'
					},
					parent: this.$component.find(".search-field"),
					render_input: true,
				});

				this.item_group_field = frappe.ui.form.make_control({
					df: {
						label: this._t("Item Group"),
						fieldtype: "Link",
						options: "Item Group",
						placeholder: this._t("Select item group"),
						description: "",
						onchange: () => {
							this.item_group = this.item_group_field.get_value() || this.parent_item_group;
							this.nav_stack = [{ type: "groups", parent: this.parent_item_group }];
							this.get_items({}).then(({ message }) => this.render_item_list(message.items, true));
							this.set_breadcrumb();
						},
						get_query: () => {
							// core query respects pos_profile filter server-side
							const doc = this.events.get_frm().doc;
							return {
								query: "erpnext.selling.page.point_of_sale.point_of_sale.item_group_query",
								filters: { pos_profile: doc ? doc.pos_profile : "" },
							};
						},
					},
					parent: this.$component.find(".item-group-field"),
					render_input: true,
				});

				this.search_field.toggle_label(false);
				this.item_group_field.toggle_label(false);

				this.attach_clear_btn();
			}

			attach_clear_btn() {
				this.search_field.$wrapper.find(".control-input").append(
					`<span class="link-btn" style="top:2px;">
						<a class="btn-open no-decoration" title="${this._t("Clear")}">
							${frappe.utils.icon("close", "sm")}
						</a>
					</span>`
				);

				this.$clear_search_btn = this.search_field.$wrapper.find(".link-btn");
				this.$clear_search_btn.on("click", "a", () => {
					this.set_search_value("");
					this.search_field.set_focus();
				});
			}

			set_search_value(value) {
				$(this.search_field.$input[0]).val(value).trigger("input");
			}

			bind_events() {
				// Use global onScan if available (no imports)
				if (window.onScan) {
					const onScan = window.onScan;

					// Our custom decode
					onScan.decodeKeyEvent = function (oEvent) {
						var iCode = this._getNormalizedKeyNum(oEvent);
						switch (true) {
							case iCode >= 48 && iCode <= 90:
							case iCode >= 106 && iCode <= 111:
							case (iCode >= 160 && iCode <= 164) || iCode == 170:
							case iCode >= 186 && iCode <= 194:
							case iCode >= 219 && iCode <= 222:
							case iCode == 32:
								if (oEvent.key !== undefined && oEvent.key !== "") return oEvent.key;
								var sDecoded = String.fromCharCode(iCode);
								return oEvent.shiftKey ? sDecoded.toUpperCase() : sDecoded.toLowerCase();
							case iCode >= 96 && iCode <= 105:
								return 0 + (iCode - 96);
						}
						return "";
					};

					try {
						// If something already attached, detach cleanly first
						if (typeof onScan.isAttachedTo === "function" && onScan.isAttachedTo(document)) {
							if (typeof onScan.detachFrom === "function") onScan.detachFrom(document);
						}
						if (typeof onScan.attachTo === "function") {
							onScan.attachTo(document, {
								onScan: (s) => {
									if (this.search_field && this.$component.is(":visible")) {
										this.search_field.set_focus();
										this.set_search_value(s);
										this.barcode_scanned = true;
									}
								},
							});
						}
					} catch (e) {
						// Ignore "already initialized" error (means original POS already attached and is fine)
						const msg = String(e || "");
						if (!/already initialized/i.test(msg)) {
							console.warn("[bot_pos] onScan attach warning:", e);
						}
					}
				}

				this.$component.on("click", ".item-wrapper", (e) => {
					const $item = $(e.currentTarget);
					const item_code = unescape($item.attr("data-item-code"));
					let batch_no = unescape($item.attr("data-batch-no"));
					let serial_no = unescape($item.attr("data-serial-no"));
					let uom = unescape($item.attr("data-uom"));
					let rate = unescape($item.attr("data-rate"));
					let stock_uom = unescape($item.attr("data-stock-uom"));
					batch_no = batch_no === "undefined" ? undefined : batch_no;
					serial_no = serial_no === "undefined" ? undefined : serial_no;
					uom = uom === "undefined" ? undefined : uom;
					rate = rate === "undefined" ? undefined : rate;
					stock_uom = stock_uom === "undefined" ? undefined : stock_uom;

					this.events.item_selected({
						field: "qty",
						value: "+1",
						item: { item_code, batch_no, serial_no, uom, rate, stock_uom },
					});
					this.search_field.set_focus();
				});

				this.search_field.$input.on("input", (e) => {
					clearTimeout(this.last_search);
					this.last_search = setTimeout(() => {
						const search_term = e.target.value;
						this.filter_items({ search_term });
					}, 300);

					this.$clear_search_btn.toggle(Boolean(this.search_field.$input.val()));
				});

				this.search_field.$input.on("focus", () => {
					this.$clear_search_btn.toggle(Boolean(this.search_field.$input.val()));
				});
			}

			attach_shortcuts() {
				const ctrl_label = frappe.utils.is_mac() ? "⌘" : "Ctrl";
				this.search_field.parent.attr("title", `${ctrl_label}+I`);
				frappe.ui.keys.add_shortcut({
					shortcut: "ctrl+i",
					action: () => this.search_field.set_focus(),
					condition: () => this.$component.is(":visible"),
					description: this._t("Focus on search input"),
					ignore_inputs: true,
					page: cur_page.page.page,
				});
				this.item_group_field.parent.attr("title", `${ctrl_label}+G`);
				frappe.ui.keys.add_shortcut({
					shortcut: "ctrl+g",
					action: () => this.item_group_field.set_focus(),
					condition: () => this.$component.is(":visible"),
					description: this._t("Focus on Item Group filter"),
					ignore_inputs: true,
					page: cur_page.page.page,
				});

				frappe.ui.keys.on("enter", () => {
					const selector_is_visible = this.$component.is(":visible");
					if (!selector_is_visible || this.search_field.get_value() === "") return;

					if (this.items && this.items.length == 1) {
						this.$items_container.find(".item-wrapper").click();
						frappe.utils.play_sound("submit");
						this.set_search_value("");
					} else if (this.items && this.items.length == 0 && this.barcode_scanned) {
						frappe.show_alert({ message: this._t("No items found. Scan barcode again."), indicator: "orange" });
						frappe.utils.play_sound("error");
						this.barcode_scanned = false;
						this.set_search_value("");
					}
				});
			}

			// keep memoized search behavior
			filter_items({ search_term = "" } = {}) {
				const selling_price_list = this.events.get_frm().doc.selling_price_list;

				if (search_term) {
					search_term = search_term.toLowerCase();
					this.search_index = this.search_index || {};
					this.search_index[selling_price_list] = this.search_index[selling_price_list] || {};
					if (this.search_index[selling_price_list][search_term]) {
						const items = this.search_index[selling_price_list][search_term];
						this.items = items;
						this.render_item_list(items, /* from_category */ this.nav_stack.length > 0);
						this.auto_add_item &&
							this.search_field.$input[0].value &&
							this.items.length == 1 &&
							this.add_filtered_item_to_cart();
						return;
					}
				}

				this.get_items({ search_term }).then(({ message }) => {
					const { items, barcode } = message;
					if (search_term && !barcode) {
						this.search_index[selling_price_list][search_term] = items;
					}
					this.items = items;
					this.render_item_list(items, /* from_category */ this.nav_stack.length > 0);
					this.auto_add_item &&
						this.search_field.$input[0].value &&
						this.items.length == 1 &&
						this.add_filtered_item_to_cart();
				});
			}

			add_filtered_item_to_cart() {
				this.$items_container.find(".item-wrapper").click();
				this.set_search_value("");
			}

			resize_selector(minimize) {
				minimize
					? this.$component.find(".filter-section").css("grid-template-columns", "repeat(1, minmax(0, 1fr))")
					: this.$component.find(".filter-section").css("grid-template-columns", "repeat(12, minmax(0, 1fr))");

				minimize
					? this.$component.find(".search-field").css("margin", "var(--margin-sm) 0px")
					: this.$component.find(".search-field").css("margin", "0px var(--margin-sm)");

				minimize ? this.$component.css("grid-column", "span 2 / span 2") : this.$component.css("grid-column", "span 6 / span 6");
				minimize
					? this.$items_container.css("grid-template-columns", "repeat(1, minmax(0, 1fr))")
					: this.$items_container.css("grid-template-columns", "repeat(4, minmax(0, 1fr))");
			}

			toggle_component(show) {
				this.set_search_value("");
				this.$component.css("display", show ? "flex" : "none");
			}
		};

		// --- 2) If POS already created an instance, replace it now ---
		const attemptReplace = () => {
			try {
				if (!window.cur_pos || !cur_pos.item_selector) return false;

				// VERY IMPORTANT: detach any existing onScan to avoid "already initialized" error
				if (window.onScan && typeof window.onScan.detachFrom === "function") {
					try { window.onScan.detachFrom(document); } catch (e) {}
				}

				const old = cur_pos.item_selector;
				const wrapper = old.wrapper;
				const settings = {
					hide_images: old.hide_images,
					auto_add_item_to_cart: old.auto_add_item
				};
				const args = {
					frm: cur_pos.frm,
					wrapper,
					events: old.events,
					pos_profile: old.pos_profile,
					settings
				};

				// remove old DOM
				if (old.$component && old.$component.length) old.$component.remove();

				// new override instance
				cur_pos.item_selector = new erpnext.PointOfSale.ItemSelector(args);
				console.log("[bot_pos] Replaced existing ItemSelector with override.");
				return true;
			} catch (e) {
				console.warn("[bot_pos] Replace attempt failed:", e);
				return false;
			}
		};

		// try immediately, then a few retries (POS builds async)
		if (!attemptReplace()) {
			let tries = 0;
			const t = setInterval(() => {
				tries += 1;
				if (attemptReplace() || tries > 50) clearInterval(t);
			}, 120);
		}
	}
})();
