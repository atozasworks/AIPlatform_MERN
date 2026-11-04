'));
          if (fail) {
            console.error('Accessibility score is below 70. This audit does not roll back the deploy.');
            process.exit(1);
          }
          EOF

  summary:
    name: PASS/FAIL summary
    needs: [changes, quality_gates, build_frontend, deploy, lighthouse]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Publish summary
        env:
          REF_NAME: ${{ github.ref_name }}
          FRONTEND_CHANGED: ${{ needs.changes.outputs.frontend }}
          BACKEND_CHANGED: ${{ needs.changes.outputs.backend }}
          QUALITY: ${{ needs.quality_gates.result }}
          BUILD: ${{ needs.build_frontend.result }}
          DEPLOY: ${{ needs.deploy.result }}
          LIGHTHOUSE: ${{ needs.lighthouse.result }}
        run: |
          set -euo pipefail
          label() {
            case "$1" in
              success) printf 'PASS' ;;
              failure) printf 'FAIL' ;;
              skipped) printf 'SKIPPED' ;;
              cancelled) printf 'CANCELLED' ;;
              *) printf '%s' "$1" ;;
            esac
          }
          if [ "${REF_NAME}" = "atozasaimain_testCICD_final_deploy" ]; then
            target="production → https://atozasai.com/"
          elif [ "${REF_NAME}" = "atozasai_testCICD_testSite_deploy" ]; then
            target="testatozas → https://testatozasai.testatozas.in/"
          else
            target="${REF_NAME}"
          fi
          {
            echo "## Deploy summary"
            echo ""
            echo "Branch \`${REF_NAME}\` → ${target}"
            echo ""
            echo "Changed: frontend=\`${FRONTEND_CHANGED}\` backend=\`${BACKEND_CHANGED}\`"
            echo ""
            echo "| Gate | Result | Required to deploy |"
            echo "|---|---|---|"
            echo "| Quality (lint, tests, Mongo contract, audit, Docker) | $(label "${QUALITY}") | yes |"
            echo "| Production build and bundle budget | $(label "${BUILD}") | yes |"
            echo "| Secure deploy, health check, rollback | $(label "${DEPLOY}") | yes |"
            echo "| Lighthouse | $(label "${LIGHTHOUSE}") | no |"
          } >> "$GITHUB_STEP_SUMMARY"
          fail=0
          for item in "${QUALITY}" "${BUILD}" "${DEPLOY}"; do
            if [ "${item}" = "failure" ] || [ "${item}" = "cancelled" ]; then
              fail=1
            fi
          done
          if [ "${fail}" = "1" ]; then
            echo "RESULT: FAIL" | tee -a "$GITHUB_STEP_SUMMARY"
            exit 1
          fi
          echo "RESULT: PASS" | tee -a "$GITHUB_STEP_SUMMARY"\n