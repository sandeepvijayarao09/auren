# One entry point for every part of Auren. Run `make` to list targets.
.DEFAULT_GOAL := help
.PHONY: help setup dev sandbox sandbox-image tunnel deploy-aws teardown-aws test check typecheck secrets keyd apple apple-build icon cert clean

APPLE_FLAGS = -project apps/apple/Auren.xcodeproj -derivedDataPath .build/apple CODE_SIGNING_ALLOWED=NO

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-14s %s\n", $$1, $$2}'

setup: ## Install dependencies and turn on the secret scan
	git config core.hooksPath .githooks
	cd core && npm install
	cd driver && npm install
	cd router && uv sync
	@if [ "$$(uname)" = Darwin ]; then $(MAKE) keyd; fi
	@test -f .env || (cp .env.example .env && echo "Created .env. Add MODEL_API_KEY from dev.meta.ai.")

dev: ## Run Core on http://127.0.0.1:8787, reloading on save
	cd core && npm run dev

sandbox: ## Run the public sandbox on http://127.0.0.1:8787/try (replays without a key)
	cd core && npm run sandbox

sandbox-image: ## Build the sandbox container image (auren-sandbox:local; see docs/deploy.md)
	docker build -t auren-sandbox:local .

tunnel: ## Run the sandbox container and share it through a Cloudflare quick tunnel (free)
	deploy/tunnel.sh

deploy-aws: ## Deploy the sandbox to Lightsail in us-east-2 and print its HTTPS URL (asks first)
	deploy/aws/deploy.sh

teardown-aws: ## Delete the Lightsail service, the SSM key and the budget (asks first)
	deploy/aws/teardown.sh

test: ## Every test that needs no API key or device
	cd core && npm test
	cd driver && npm test
	cd router && uv run python -m unittest discover -s tests -t .
	cd apps/apple/AurenKit && swift test
	@if [ "$$(uname)" = Darwin ]; then cd keyd && swift test; fi

typecheck: ## Type-check Core and the driver
	cd core && npm run typecheck
	cd driver && npm run typecheck

secrets: ## Scan the git history for secrets
	gitleaks git --redact --no-banner

check: test typecheck secrets ## Everything CI runs

keyd: ## Build auren-keyd, which seals Core's master key to the Secure Enclave
	cd keyd && swift build -c release

apple: ## Generate the Xcode project from apps/apple/project.yml
	cd apps/apple && xcodegen generate

apple-build: apple ## Build the iPhone and Apple Watch apps for the Simulator
	xcodebuild $(APPLE_FLAGS) -scheme Auren -destination 'generic/platform=iOS Simulator' build -quiet

icon: ## Redraw the app icons from the mark
	swift brand/make-icon.swift apps/apple/iOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png
	cp apps/apple/iOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png apps/apple/Watch/Assets.xcassets/AppIcon.appiconset/icon-1024.png

cert: ## Make a local CA and a TLS cert for Core in certs/ (see docs/runbook.md)
	sh core/scripts/make-cert.sh

clean: ## Remove build output (keeps .env and auren.db)
	rm -rf .build apps/apple/Auren.xcodeproj
