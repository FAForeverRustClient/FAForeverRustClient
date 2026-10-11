// The host dialog's map picker: its filters and how they are remembered, the
// filter popover's dismissal, the narrowed and favourite lists, keyboard
// selection, and whether the enlarged preview is open. The selection itself
// belongs to the dialog, which hosts on it; this only moves it.
//
// The picker is one value, memoised, and every function in it is stable for
// as long as what it reads is: the map column is memoised on it, and it is
// the column with every map in it, so a keystroke in the lobby title must not
// hand it a new picker.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOverlayLayer } from "../../../design-system/useOverlayLayer";
import { ipc } from "../../../ipc/client";
import { focusListboxOption, nextListboxIndex } from "../../../shared/listboxNavigation";
import { isFilterRecord, rememberedFilter, useRememberFilter } from "../../../shared/filterMemory";
import {
  activeFilterCount as countActiveFilters,
  filterHostMaps,
  NO_PICKER_FILTERS,
  resolveChosenMap,
  type HostMap,
  type MapPickerFilters,
} from "./hostMapCatalogue";

/**
 * Where the picker is remembered as the dialog was last left, for the next
 * time it opens (#387): what was asked for is not having to narrow the list
 * down again after hosting. For how long is the filter setting's to say
 * (#447), like every list's filters.
 */
const HOST_MAP_FILTERS = "host.maps";

interface Options {
  /** Every map the dialog can host, before any filter. */
  catalogueMaps: HostMap[];
  /** The browsing preferences' favourite map folders. */
  favoriteMaps: string[];
  selectedMap: string;
  setSelectedMap: (folderName: string) => void;
}

export type HostMapPicker = ReturnType<typeof useHostMapPicker>;

export function useHostMapPicker({ catalogueMaps, favoriteMaps, selectedMap, setSelectedMap }: Options) {
  // The map picker's own controls, as one value so a change or a reset is one
  // update rather than seven. They outlive the dialog (see `HOST_MAP_FILTERS`);
  // the filter popover does not reopen with them.
  const [picker, setPicker] = useState<MapPickerFilters>(() => ({
    ...NO_PICKER_FILTERS,
    ...rememberedFilter<Partial<MapPickerFilters>>(HOST_MAP_FILTERS, {}, isFilterRecord),
    filtersOpen: false,
  }));
  useRememberFilter(HOST_MAP_FILTERS, picker);
  const { mapSearch, rankedFilter, widthKm, heightKm, playerCount, filtersOpen, mapTab } = picker;
  const filter = useCallback(
    (patch: Partial<MapPickerFilters>) => setPicker((current) => ({ ...current, ...patch })),
    [],
  );
  const toggleFilters = useCallback(
    () => setPicker((current) => ({ ...current, filtersOpen: !current.filtersOpen })),
    [],
  );

  const filterRef = useRef<HTMLDivElement>(null);
  const mapListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filtersOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !filterRef.current?.contains(event.target)) {
        filter({ filtersOpen: false });
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [filtersOpen, filter]);
  // Escape closes the filter popover first and the dialog on the next press:
  // while open, the popover is the top of the overlay stack.
  useOverlayLayer(filtersOpen, () => filter({ filtersOpen: false }));

  // The only step the search box and the filters touch.
  const availableMaps = useMemo(
    () => filterHostMaps(catalogueMaps, { mapSearch, rankedFilter, widthKm, heightKm, playerCount }),
    [catalogueMaps, heightKm, mapSearch, playerCount, rankedFilter, widthKm],
  );

  // Favourites are already a thing in the map vault, kept as folder names in
  // the browsing preferences. This reuses that list rather than starting a
  // second one: a map starred here is starred there and the other way round.
  const favoriteFolders = useMemo(
    () => new Set(favoriteMaps.map((folder) => folder.toLocaleLowerCase())),
    [favoriteMaps],
  );
  const isFavorite = useCallback(
    (folderName: string) => favoriteFolders.has(folderName.toLocaleLowerCase()),
    [favoriteFolders],
  );
  // One folder and a direction, applied by the backend to the list it holds:
  // a whole list built here from the snapshot lost a star whenever two were
  // clicked inside one round trip.
  const toggleFavorite = useCallback(
    (folderName: string) => {
      ipc.send({
        kind: "Settings",
        command: {
          type: "setListMember",
          payload: { list: "favoriteMaps", value: folderName, member: !isFavorite(folderName) },
        },
      });
    },
    [isFavorite],
  );

  const visibleMaps = useMemo(
    () => (mapTab === "favorites"
      ? availableMaps.filter((map) => favoriteFolders.has(map.folderName.toLocaleLowerCase()))
      : availableMaps),
    [availableMaps, favoriteFolders, mapTab],
  );

  const chosen = resolveChosenMap(availableMaps, visibleMaps, selectedMap);

  // The picture in this column is the only look at the map anybody gets before
  // hosting on it, and it is a 200 px square.
  const [previewOpen, setPreviewOpen] = useState(false);

  // Shown on the filter button so a narrowed list is never a mystery.
  const activeFilterCount = countActiveFilters(picker);

  const chooseRandom = useCallback(() => {
    // Out of what is on screen, so a random pick from the Favourites tab is a
    // random favourite rather than a random map.
    if (visibleMaps.length === 0) return;
    const index = Math.floor(Math.random() * visibleMaps.length);
    setSelectedMap(visibleMaps[index].folderName);
  }, [visibleMaps, setSelectedMap]);

  /// Walk the map list from the keyboard, selecting as it goes: the preview,
  /// the size and the player count all hang off the selection, so moving only
  /// focus - which is all the browser did - showed none of them.
  const onMapListKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const current = visibleMaps.findIndex((map) => map.folderName === chosen?.folderName);
      const next = nextListboxIndex(event.key, current, visibleMaps.length);
      if (next === null) return;
      // Otherwise the arrow key also scrolls the column, away from the row it
      // just moved to.
      event.preventDefault();
      setSelectedMap(visibleMaps[next].folderName);
      focusListboxOption(mapListRef.current, next);
    },
    [visibleMaps, chosen, setSelectedMap],
  );

  return useMemo(
    () => ({
      filters: picker,
      filter,
      toggleFilters,
      filterRef,
      mapListRef,
      availableMaps,
      visibleMaps,
      favoriteFolders,
      isFavorite,
      toggleFavorite,
      chosen,
      selectMap: setSelectedMap,
      activeFilterCount,
      chooseRandom,
      onMapListKeyDown,
      previewOpen,
      setPreviewOpen,
    }),
    [
      picker, filter, toggleFilters, availableMaps, visibleMaps, favoriteFolders, isFavorite, toggleFavorite,
      chosen, setSelectedMap, activeFilterCount, chooseRandom, onMapListKeyDown, previewOpen,
    ],
  );
}
