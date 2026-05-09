import unittest
from unittest.mock import patch

from garmin_client.client import GarminClient


class FakePage:
    def __init__(self, responses, initial_url="https://connect.garmin.com/modern/", goto_responses=None):
        self._responses = list(responses)
        self._goto_responses = list(goto_responses or [])
        self.url = initial_url
        self.goto_calls = []
        self.waits = []

    def goto(self, url, wait_until=None, timeout=None):
        self.goto_calls.append((url, wait_until, timeout))
        if self._goto_responses:
            response = self._goto_responses.pop(0)
            if isinstance(response, Exception):
                raise response
        self.url = url

    def wait_for_load_state(self, state, timeout=None):
        self.waits.append((state, timeout))

    def evaluate(self, expression, arg=None):
        if not self._responses:
            raise AssertionError("No fake responses left for evaluate()")
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def make_client(page):
    client = object.__new__(GarminClient)
    client._page = page
    client._context = None
    client._playwright = None
    client._browser_ref = None
    client._csrf = None
    client._display_name = None
    client._engine = None
    client.session_file = None
    client._fetch_timeout_ms = 30000
    client._fetch_batch_retries = 3
    return client


class GarminClientRetryTests(unittest.TestCase):
    @patch("garmin_client.client.time.sleep", return_value=None)
    def test_post_login_setup_retries_after_context_loss(self, _sleep):
        page = FakePage(
            [
                Exception("Page.evaluate: Execution context was destroyed, most likely because of a navigation"),
                {"csrf": "token-123", "profileStatus": 200, "displayName": "Via"},
            ]
        )
        client = make_client(page)

        ok = client._post_login_setup()

        self.assertTrue(ok)
        self.assertEqual(client._csrf, "token-123")
        self.assertEqual(client._display_name, "Via")
        self.assertEqual(page.goto_calls[0][0], "about:blank")
        self.assertEqual(page.goto_calls[1][0], "https://connect.garmin.com/modern/")

    @patch("garmin_client.client.time.sleep", return_value=None)
    def test_fetch_batch_refreshes_setup_after_context_loss(self, _sleep):
        page = FakePage(
            [
                Exception("Page.evaluate: Execution context was destroyed, most likely because of a navigation"),
                {"csrf": "fresh-token", "profileStatus": 200, "displayName": "Via"},
                {"summary": {"status": 200, "data": {"steps": 1234}}},
            ]
        )
        client = make_client(page)

        result = client._fetch_batch({"summary": "/gc-api/example"}, {})

        self.assertEqual(result["summary"]["status"], 200)
        self.assertEqual(client._csrf, "fresh-token")
        self.assertEqual(client._display_name, "Via")

    @patch("garmin_client.client.time.sleep", return_value=None)
    def test_fetch_batch_retries_when_app_page_is_temporarily_unavailable(self, _sleep):
        page = FakePage(
            [
                {"csrf": "fresh-token", "profileStatus": 200, "displayName": "Via"},
                {"summary": {"status": 200, "data": {"steps": 1234}}},
            ],
            initial_url="https://sso.garmin.com/portal/sso/en-US/sign-in",
            goto_responses=[Exception("temporary navigation failure"), None],
        )
        client = make_client(page)

        result = client._fetch_batch({"summary": "/gc-api/example"}, {})

        self.assertEqual(result["summary"]["status"], 200)
        self.assertEqual(len(page.goto_calls), 2)

    @patch("garmin_client.client.time.sleep", return_value=None)
    def test_fetch_batch_uses_single_evaluate_attempt_per_outer_retry(self, _sleep):
        page = FakePage(
            [
                Exception("Browser evaluation timed out during fetch batch after 45s"),
                {"csrf": "fresh-token", "profileStatus": 200, "displayName": "Via"},
                {"summary": {"status": 200, "data": {"steps": 1234}}},
            ]
        )
        client = make_client(page)

        result = client._fetch_batch({"summary": "/gc-api/example"}, {})

        self.assertEqual(result["summary"]["status"], 200)
        self.assertEqual(page.goto_calls[0][0], "about:blank")
        self.assertEqual(page.goto_calls[1][0], "https://connect.garmin.com/modern/")

    @patch("garmin_client.client.time.sleep", return_value=None)
    def test_post_login_setup_rejects_csrf_without_valid_profile_session(self, _sleep):
        page = FakePage(
            [
                {"csrf": "stale-token", "profileStatus": 401, "displayName": None},
                {"csrf": None, "profileStatus": 401, "displayName": None},
                {"csrf": "stale-token", "profileStatus": 403, "displayName": None},
            ]
        )
        client = make_client(page)

        ok = client._post_login_setup()

        self.assertFalse(ok)
        self.assertIsNone(client._csrf)
        self.assertIsNone(client._display_name)


if __name__ == "__main__":
    unittest.main()
