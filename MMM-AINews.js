/**
 * MMM-AINews — Frontend Module
 *
 * Displays AI-generated summaries of RSS news feeds.
 * Each configured source produces one paragraph.
 */
Module.register("MMM-AINews", {
	defaults: {
		updateInterval: 30 * 60 * 1000, // 30 minutes
		sources: [],
		model: "gpt-5-mini",
		credentialsPath: "credentials/github-oauth.json",
		showSourceLabels: true,
		showUpdatedAt: true,
		alwaysShowUpdatedAt: true,
		staleThresholdMs: 2 * 60 * 60 * 1000, // 2 hours
		maxFrameWidth: 400,
		animationSpeed: 1000
	},

	getStyles: function () {
		return ["MMM-AINews.css"];
	},

	getHeader: function () {
		return this.config.header || this.data.header;
	},

	start: function () {
		Log.info(`Starting module: ${this.name}`);
		this.summaries = null;
		this.updatedAt = null;
		this.error = null;
		this.loaded = false;

		this.sendSocketNotification("START_FETCHING", this.config);
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "AINEWS_DATA") {
			this.summaries = payload.results;
			this.updatedAt = payload.updatedAt;
			this.error = null;
			this.loaded = true;
			this.updateDom(this.config.animationSpeed);
		} else if (notification === "AINEWS_ERROR") {
			this.error = payload.error;
			this.updateDom(this.config.animationSpeed);
		}
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "ainews-wrapper";
		wrapper.style.maxWidth = this.config.maxFrameWidth + "px";

		// Loading state
		if (!this.loaded && !this.error) {
			wrapper.innerHTML = "<span class=\"ainews-loading dimmed small\">Loading news summaries…</span>";
			return wrapper;
		}

		// Error state (show error but also show stale data if available)
		if (this.error && !this.summaries) {
			wrapper.innerHTML = `<span class="ainews-error small">${this.error}</span>`;
			return wrapper;
		}

		// Summaries
		if (this.summaries) {
			const hasAnySummary = this.summaries.some((s) => s.summary);

			if (!hasAnySummary) {
				wrapper.innerHTML = "<span class=\"ainews-empty dimmed small\">No news summaries available.</span>";
			} else {
				for (const source of this.summaries) {
					if (!source.summary) continue;

					const section = document.createElement("div");
					section.className = "ainews-section";

					if (this.config.showSourceLabels && this.summaries.length > 1) {
						const label = document.createElement("span");
						label.className = "ainews-label dimmed xsmall";
						label.textContent = source.name;
						section.appendChild(label);
					}

					const paragraph = document.createElement("p");
					paragraph.className = "ainews-paragraph small light";
					paragraph.textContent = source.summary;
					section.appendChild(paragraph);

					wrapper.appendChild(section);
				}
			}
		}

		// Always show updated-at footer (matching calcifer's behavior)
		if (this.config.showUpdatedAt) {
			const footer = document.createElement("div");
			footer.className = "ainews-footer dimmed xsmall";

			if (this.updatedAt) {
				const age = Date.now() - new Date(this.updatedAt).getTime();
				const isStale = age > this.config.staleThresholdMs;

				const time = new Date(this.updatedAt).toLocaleString([], {
					month: "short",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit"
				});

				footer.textContent = "Last updated: " + time;
				if (isStale) {
					footer.textContent += " \u26A0";
					footer.classList.add("ainews-stale");
				}
			} else {
				footer.textContent = "Last updated: waiting for first refresh";
			}

			wrapper.appendChild(footer);
		}

		return wrapper;
	}
});
