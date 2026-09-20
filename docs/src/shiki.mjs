const palette = (name, type, colors) => ({
  name,
  type,
  settings: [
    { settings: { foreground: colors.ink, background: colors.background } },
    {
      scope: ["comment"],
      settings: { foreground: colors.comment, fontStyle: "italic" }
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier"],
      settings: { foreground: colors.keyword }
    },
    {
      scope: ["keyword.operator", "punctuation"],
      settings: { foreground: colors.punctuation }
    },
    { scope: ["string"], settings: { foreground: colors.string } },
    {
      scope: ["constant.numeric", "constant.language"],
      settings: { foreground: colors.constant }
    },
    {
      scope: ["support.type.property-name", "variable", "support.variable"],
      settings: { foreground: colors.ink }
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "entity.name.type",
        "support.type",
        "support.class"
      ],
      settings: { foreground: colors.entity }
    }
  ]
});

export const shikiThemes = {
  light: palette("walter-light", "light", {
    ink: "#364339",
    background: "#f2f4f1",
    comment: "#718075",
    keyword: "#266552",
    punctuation: "#738076",
    string: "#72592e",
    constant: "#7e5445",
    entity: "#234b3b"
  }),
  dark: palette("walter-dark", "dark", {
    ink: "#cbd4cb",
    background: "#171b18",
    comment: "#86928a",
    keyword: "#95c9ac",
    punctuation: "#859187",
    string: "#c8b996",
    constant: "#ceb2a1",
    entity: "#e2e8dc"
  })
};
