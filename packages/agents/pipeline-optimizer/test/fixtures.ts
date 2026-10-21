import type {JobInfo, PipelineSummary} from "@aicd/plugin-sdk";

export const GITLAB_CI = `stages:
  - install
  - build
  - test
  - deploy

variables:
  NODE_ENV: test

default:
  image: node:22-alpine

.node_setup:
  before_script:
    - npm ci

.test_script:
  script:
    - npm run test:unit -- --reporter=junit

install:
  stage: install
  script:
    - npm ci
  artifacts:
    paths: [node_modules/]

build:
  stage: build
  extends: .node_setup
  script:
    - npm run build

lint:
  stage: test
  extends: .node_setup
  script:
    - npm run lint

eslint:
  stage: test
  extends: .node_setup
  script:
    - npm run lint

unit_tests:
  stage: test
  extends: .node_setup
  script:
    - !reference [.test_script, script]

e2e:
  stage: test
  image: mcr.microsoft.com/playwright:v1.48.0-jammy
  cache:
    key:
      files: [package-lock.json]
    paths: [.npm/]
  script:
    - npm ci --cache .npm --prefer-offline
    - npx playwright test

deploy:
  stage: deploy
  script:
    - ./scripts/deploy.sh production
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
`;

/** Same pipeline, already optimized. */
export const GITLAB_CI_GOOD = `stages: [build, test, deploy]

default:
  image: node:22-alpine
  interruptible: true
  cache:
    key:
      files: [package-lock.json]
    paths: [.npm/]

workflow:
  rules:
    - changes: ["src/**/*", "package-lock.json", ".gitlab-ci.yml"]

build:
  stage: build
  script:
    - npm ci --cache .npm
    - npm run build

test:
  stage: test
  needs: [build]
  script:
    - npm ci --cache .npm
    - npm test

deploy:
  stage: deploy
  needs: [test]
  script:
    - ./scripts/deploy.sh production
`;

export const GITHUB_WORKFLOW = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint

  python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
      - run: |
          pip install -r requirements.txt
          pytest -q
`;

export const GITHUB_WORKFLOW_GOOD = `name: CI
on:
  pull_request:
    paths-ignore: ["docs/**", "**/*.md"]
  push:
    tags: ["v*"]

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.23"
      - run: go build ./...
      - run: go test ./...
`;

const MIN = 60;

/**
 * Ten pipelines of the GitLab fixture: unit_tests is slow and fails then passes on retry in 3 of
 * them; every pipeline waits about 3 minutes for a runner.
 */
export function gitlabHistory(count = 10): PipelineSummary[] {
    const pipelines: PipelineSummary[] = [];
    for (let index = 0; index < count; index++) {
        const id = String(1000 + index);
        const day = `2026-10-${String(index + 1).padStart(2, "0")}`;
        let jobId = index * 100;
        const job = (name: string, stage: string, minutes: number, status: JobInfo["status"] = "success"): JobInfo => ({
            id: String(++jobId),
            name,
            stage,
            status,
            durationSeconds: Math.round(minutes * MIN),
            queuedSeconds: 150 + index * 10,
            startedAt: `${day}T10:${String(jobId % 60).padStart(2, "0")}:00Z`,
            finishedAt: `${day}T10:${String(jobId % 60).padStart(2, "0")}:30Z`
        });
        const jobs = [
            job("install", "install", 4 + (index % 3) * 0.5),
            job("build", "build", 3),
            job("lint", "test", 1),
            job("eslint", "test", 1),
            ...(index % 3 === 0 ? [job("unit_tests", "test", 6, "failed")] : []),
            job("unit_tests", "test", 12 + index * 0.2),
            job("e2e", "test", 5),
            job("deploy", "deploy", 2)
        ];
        pipelines.push({id, branch: "main", status: "success", createdAt: `${day}T10:00:00Z`, jobs});
    }
    return pipelines.reverse();
}
