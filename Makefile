# One entry point for every part of Auren. Run `make` to list targets.
.DEFAULT_GOAL := help
.PHONY: help setup dev test check typecheck secrets apple apple-build icon clean

APPLE_FLAGS = -project apps/apple/Auren.xcodeproj -derivedDataPath .build/apple CODE_SIGNING_ALLOWED=NO

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-12s %s\n", $$1, $$2}'

setup: ## Install dependencies and turn on the secret scan
	git config core.hooksPath .githooks
	cd core && npm install
	cd driver && npm install
	cd router && uv sync
	@test -f .env || (cp .env.example .env && echo "Created .env. Add MODEL_API_KEY from dev.meta.ai.")

dev: ## Run Core on http://127.0.0.1:8787, reloading on save
	cd core && npm run dev

test: ## Every test that needs no API key or device
	cd core && npm test
	cd driver && npm test
	cd router && uv run python -m unittest discover -s tests -t .
	cd apps/apple/AurenKit && swift test

typecheck: ## Type-check Core and the driver
	cd core && npm run typecheck
	cd driver && npm run typecheck

secrets: ## Scan the git history for secrets
	gitleaks git --redact --no-banner

check: test typecheck secrets ## Everything CI runs

apple: ## Generate the Xcode project from apps/apple/project.yml
	cd apps/apple && xcodegen generate

apple-build: apple ## Build the iPhone and Apple Watch apps for the Simulator
	xcodebuild $(APPLE_FLAGS) -scheme Auren -destination 'generic/platform=iOS Simulator' build -quiet

icon: ## Redraw the app icons from the mark
	swift brand/make-icon.swift apps/apple/iOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png
	cp apps/apple/iOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png apps/apple/Watch/Assets.xcassets/AppIcon.appiconset/icon-1024.png

clean: ## Remove build output (keeps .env and auren.db)
	rm -rf .build apps/apple/Auren.xcodeproj
