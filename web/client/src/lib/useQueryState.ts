import { useCallback, useEffect, useState } from "preact/hooks";

/**
 * Two-way bind a component's state to a URL query param.
 *
 * - Initial value is read from `window.location.search` on mount.
 * - Setter writes via `history.replaceState` so dropdown changes don't
 *   stack a new entry for every click (back button stays useful).
 * - Listens for `popstate` so browser back/forward still syncs state.
 * - A value equal to the default is *removed* from the URL (cleaner links).
 */
export function useQueryState(
  key: string,
  defaultValue: string = ""
): [string, (v: string) => void] {
  const read = () =>
    new URLSearchParams(window.location.search).get(key) ?? defaultValue;

  const [value, setValue] = useState<string>(read);

  const update = useCallback(
    (v: string) => {
      setValue(v);
      const params = new URLSearchParams(window.location.search);
      if (v === defaultValue || v === "" || v == null) {
        params.delete(key);
      } else {
        params.set(key, v);
      }
      const qs = params.toString();
      const url =
        window.location.pathname +
        (qs ? `?${qs}` : "") +
        window.location.hash;
      window.history.replaceState(window.history.state, "", url);
    },
    [key, defaultValue]
  );

  useEffect(() => {
    const onPop = () => setValue(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // read() closes over `key`/`defaultValue`; effect re-subs if either changes.
  }, [key, defaultValue]);

  return [value, update];
}
