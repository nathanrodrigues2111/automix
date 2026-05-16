SHELL := /bin/bash

PYTHON ?= $(shell command -v python3.11 2>/dev/null || command -v python3.12 2>/dev/null || command -v python3)

.PHONY: install dev dev-backend dev-frontend test lint clean check-system help

help:
	@echo "Targets:"
	@echo "  install        Create backend venv + install Python and frontend deps"
	@echo "  dev            Run backend and frontend in parallel (Ctrl-C stops both)"
	@echo "  dev-backend    Run FastAPI on :8000"
	@echo "  dev-frontend   Run Vite dev server on :5173"
	@echo "  test           Run backend pytest suite"
	@echo "  lint           Run ruff (backend) and eslint (frontend, if configured)"
	@echo "  clean          Remove venv, caches, node_modules, dist"
	@echo "  check-system   Verify ffmpeg, rubberband, python (3.11+), node, npm"

install:
	@echo ">>> Installing backend with $(PYTHON)"
	@cd backend && $(PYTHON) -m venv .venv && ./.venv/bin/pip install --upgrade pip && ./.venv/bin/pip install -e .
	@echo ">>> Installing frontend (npm)"
	@cd frontend && npm install
	@echo ">>> Install complete."

dev:
	@echo ">>> Starting backend (:8000) and frontend (:5173). Ctrl-C to stop both."
	@trap 'echo; echo ">>> Stopping..."; kill 0' INT TERM EXIT; \
		( cd backend && ./.venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port 8000 ) & \
		( cd frontend && npm run dev ) & \
		wait

dev-backend:
	@cd backend && ./.venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port 8000

dev-frontend:
	@cd frontend && npm run dev

test:
	@cd backend && ./.venv/bin/pytest -v

lint:
	@cd backend && ./.venv/bin/ruff check .
	@cd frontend && if [ -f node_modules/.bin/eslint ] || grep -q '"lint"' package.json 2>/dev/null; then \
		npm run lint; \
	else \
		echo "(frontend lint not configured — skipping)"; \
	fi

clean:
	@echo ">>> Cleaning build artifacts"
	@rm -rf backend/.venv backend/.cache backend/.pytest_cache backend/*.egg-info
	@rm -rf frontend/node_modules frontend/dist frontend/.vite
	@echo ">>> Clean."

check-system:
	@bash scripts/check-system.sh
