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
    ink: "#343b33",
    background: "#f3f3f1",
    comment: "#626d61",
    keyword: "#266552",
    punctuation: "#657062",
    string: "#72592e",
    constant: "#7e5445",
    entity: "#234b3b"
  }),
  dark: palette("walter-dark", "dark", {
    ink: "#d3d8ce",
    background: "#1b1d19",
    comment: "#969f8f",
    keyword: "#95c9ac",
    punctuation: "#a0a898",
    string: "#c8b996",
    constant: "#ceb2a1",
    entity: "#e2e8dc"
  })
};
