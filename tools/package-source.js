var _ = require('underscore');
var sourcemap = require('source-map');

var files = require('./files.js');
var utils = require('./utils.js');
var watch = require('./watch.js');
var buildmessage = require('./buildmessage.js');
var meteorNpm = require('./meteor-npm.js');
var NpmDiscards = require('./npm-discards.js');
var Builder = require('./builder.js');
var archinfo = require('./archinfo.js');
var release = require('./release.js');
var catalog = require('./catalog.js');
var packageVersionParser = require('./package-version-parser.js');
var compiler = require('./compiler.js');

// XXX: This is a medium-term hack, to avoid having the user set a package name
// & test-name in package.describe. We will change this in the new control file
// world in some way.
var AUTO_TEST_PREFIX = "local-test:";
var isTestName = function (name) {
  var nameStart = name.slice(0, AUTO_TEST_PREFIX.length);
  return nameStart === AUTO_TEST_PREFIX;
};
var genTestName = function (name) {
  return AUTO_TEST_PREFIX + name;
};

// Returns a sort comparator to order files into load order.
// templateExtensions should be a list of extensions like 'html'
// which should be loaded before other extensions.
var loadOrderSort = function (templateExtensions) {
  var templateExtnames = {};
  _.each(templateExtensions, function (extension) {
    templateExtnames['.' + extension] = true;
  });

  return function (a, b) {
    // XXX MODERATELY SIZED HACK --
    // push template files ahead of everything else. this is
    // important because the user wants to be able to say
    //   Template.foo.events = { ... }
    // in a JS file and not have to worry about ordering it
    // before the corresponding .html file.
    //
    // maybe all of the templates should go in one file?
    var isTemplate_a = _.has(templateExtnames, files.pathExtname(a));
    var isTemplate_b = _.has(templateExtnames, files.pathExtname(b));
    if (isTemplate_a !== isTemplate_b) {
      return (isTemplate_a ? -1 : 1);
    }

    // main.* loaded last
    var ismain_a = (files.pathBasename(a).indexOf('main.') === 0);
    var ismain_b = (files.pathBasename(b).indexOf('main.') === 0);
    if (ismain_a !== ismain_b) {
      return (ismain_a ? 1 : -1);
    }

    // /lib/ loaded first
    var islib_a = (a.indexOf(files.pathSep + 'lib' + files.pathSep) !== -1 ||
                   a.indexOf('lib' + files.pathSep) === 0);
    var islib_b = (b.indexOf(files.pathSep + 'lib' + files.pathSep) !== -1 ||
                   b.indexOf('lib' + files.pathSep) === 0);
    if (islib_a !== islib_b) {
      return (islib_a ? -1 : 1);
    }

    // deeper paths loaded first.
    var len_a = a.split(files.pathSep).length;
    var len_b = b.split(files.pathSep).length;
    if (len_a !== len_b) {
      return (len_a < len_b ? 1 : -1);
    }

    // otherwise alphabetical
    return (a < b ? -1 : 1);
  };
};

// We currently have a 1 to 1 mapping between 'where' and 'arch'.
// 'client' -> 'web'
// 'server' -> 'os'
// '*' -> '*'
var mapWhereToArch = function (where) {
  if (where === 'server') {
    return 'os';
  } else if (where === 'client') {
    return 'web';
  } else {
    return where;
  }
};

var splitConstraint = function (c) {
  // XXX print error better (w/ buildmessage?)?
  var parsed = utils.parsePackageConstraint(c);
  return { package: parsed.package,
           constraint: parsed.constraintString || null };
};

// Given the text of a README.md file, excerpts the text between the first and
// second heading.
//
// Specifically - if there is text between the document name, and the first
// subheading, it will take that text. If there is no text there, and only text
// after the first subheading, it will take that text. It won't look any deeper
// than that (in case the user intentionally wants to leave the section blank
// for some reason). Skips lines that start with an exclamation point.
var getExcerptFromReadme = function (text) {
  // Don't waste time parsing if the document is empty.
  if (! text) return "";

  // Split into lines with Commonmark.
  var commonmark = require('commonmark');
  var reader = new commonmark.DocParser();
  var parsed = reader.parse(text);

  // Commonmark will parse the Markdown into an array of nodes. These are the
  // nodes that represent the text between the first and second heading.
  var relevantNodes = [];

  // Go through the document until we get the nodes that we are looking for,
  // then stop.
  _.any(parsed.children, function (child) {
    var isHeader = (child.t === "Header");
    // Don't excerpt anything before the first header.
    if (! isHeader) {
      // If we are currently in the middle of excerpting, continue doing that
      // until we hit hit a header (and this is not a header). Otherwise, if
      // this is text, we should begin to excerpt it.
      relevantNodes.push(child);
    } else if (! _.isEmpty(relevantNodes) && isHeader) {
      // We have been excerpting, and came across a header. That means
      // that we are done.
      return true;
    }
    return false;
  });

  // If we have not found anything, we are done.
  if (_.isEmpty(relevantNodes)) return "";

  // For now, we will do the simple thing of just taking the raw markdown from
  // the start of the excerpt to the end.
  var textLines = text.split("\n");
  var start = relevantNodes[0].start_line - 1;
  var stop = _.last(relevantNodes).end_line;
  // XXX: There is a bug in commonmark that happens when processing the last
  // node in the document. Here is the github issue:
  // https://github.com/jgm/CommonMark/issues/276
  // Remove this workaround when the issue is fixed.
  if (stop === _.last(parsed.children).end_line) {
    stop++;
  }
  var excerpt = textLines.slice(start, stop).join("\n");

  // Strip the preceeding and trailing new lines.
  return excerpt.replace(/^\n+|\n+$/g, "");
};

///////////////////////////////////////////////////////////////////////////////
// SourceArch
///////////////////////////////////////////////////////////////////////////////

// Options:
// - kind [required]
// - arch [required]
// - uses
// - implies
// - getSourcesFunc
// - declaredExports
// - watchSet
//
// Do not include the source files in watchSet. They will be
// added at compile time when the sources are actually read.
var SourceArch = function (pkg, options) {
  var self = this;
  options = options || {};
  self.pkg = pkg;

  // Kind of this sourceArchitecture. At the moment, there are really three
  // options -- package, plugin, and app. We use these in linking.
  self.kind = options.kind;

  // The architecture (fully or partially qualified) that can use this
  // unibuild.
  self.arch = options.arch;

  // Packages used. The ordering is significant only for determining
  // import symbol priority (it doesn't affect load order), and a
  // given package could appear more than once in the list, so code
  // that consumes this value will need to guard appropriately. Each
  // element in the array has keys:
  // - package: the package name
  // - constraint: the constraint on the version of the package to use,
  //   as a string (may be null)
  // - unordered: If true, we don't want the package's imports and we
  //   don't want to force the package to load before us. We just want
  //   to ensure that it loads if we load.
  // - weak: If true, we don't *need* to load the other package, but
  //   if the other package ends up loaded in the target, it must
  //   be forced to load before us. We will not get its imports
  //   or plugins.
  // It is an error for both unordered and weak to be true, because
  // such a dependency would have no effect.
  //
  // In most places, instead of using 'uses' directly, you want to use
  // something like compiler.eachUsedUnibuild so you also take into
  // account implied packages.
  self.uses = options.uses || [];

  // Packages which are "implied" by using this package. If a unibuild X
  // uses this unibuild Y, and Y implies Z, then X will effectively use Z
  // as well (and get its imports and plugins).  An array of objects
  // of the same type as the elements of self.uses (although for now
  // unordered and weak are not allowed).
  self.implies = options.implies || [];

  // A function that returns the source files for this architecture. Array of
  // objects with keys "relPath" and "fileOptions". Null if loaded from
  // isopack.
  //
  // fileOptions is optional and represents arbitrary options passed
  // to "api.addFiles"; they are made available on to the plugin as
  // compileStep.fileOptions.
  //
  // This is a function rather than a literal array because for an
  // app, we need to know the file extensions registered by the
  // plugins in order to compute the sources list, so we have to wait
  // until build time (after we have loaded any plugins, including
  // local plugins in this package) to compute this.
  self.getSourcesFunc = options.getSourcesFunc || null;

  // Symbols that this architecture should export. List of symbols (as
  // strings).
  self.declaredExports = options.declaredExports || null;

  // Files and directories that we want to monitor for changes in
  // development mode, as a watch.WatchSet. In the latest refactoring
  // of the code, this does not include source files or directories,
  // but only control files such as package.js and .meteor/packages,
  // since the rest are not determined until compile time.
  self.watchSet = options.watchSet || new watch.WatchSet;
};

///////////////////////////////////////////////////////////////////////////////
// PackageSource
///////////////////////////////////////////////////////////////////////////////

var PackageSource = function () {
  var self = this;

  // The name of the package, or null for an app pseudo-package or
  // collection. The package's exports will reside in Package.<name>.
  // When it is null it is linked like an application instead of like
  // a package.
  self.name = null;

  // The path relative to which all source file paths are interpreted
  // in this package. Also used to compute the location of the
  // package's .npm directory (npm shrinkwrap state).
  self.sourceRoot = null;

  // Path that will be prepended to the URLs of all resources emitted
  // by this package (assuming they don't end up getting
  // concatenated). For non-web targets, the only effect this will
  // have is to change the actual on-disk paths of the files in the
  // bundle, for those that care to open up the bundle and look (but
  // it's still nice to get it right).
  self.serveRoot = null;

  // Package metadata. Keys are 'summary', 'git' and 'documentation'. Currently
  // all of these are optional.
  self.metadata = {};
  self.docsExplicitlyProvided = false;

  // Package version as a meteor-version string. Optional; not all packages
  // (for example, the app) have versions.
  // XXX when we have names, maybe we want to say that all packages
  // with names have versions? certainly the reverse is true
  self.version = null;
  self.versionExplicitlyProvided = false;

  // Available architectures of this package. Array of SourceArch.
  self.architectures = [];

  // The information necessary to build the plugins in this
  // package. Map from plugin name to object with keys 'name', 'use',
  // 'sources', and 'npmDependencies'.
  self.pluginInfo = {};

  // Analogous to watchSet in SourceArch but for plugins. At this
  // stage will typically contain just 'package.js'.
  self.pluginWatchSet = new watch.WatchSet;

  // npm packages used by this package (on os.* architectures only).
  // Map from npm package name to the required version of the package
  // as a string.
  self.npmDependencies = {};

  // Files to be stripped from the installed NPM dependency tree. See the
  // Npm.strip comment below for further usage information.
  self.npmDiscards = new NpmDiscards;

  // Absolute path to a directory on disk that serves as a cache for
  // the npm dependencies, so we don't have to fetch them on every
  // build. Required not just if we have npmDependencies, but if we
  // ever could have had them in the past.
  self.npmCacheDirectory = null;

  // cordova plugins used by this package (on os.* architectures only).
  // Map from cordova plugin name to the required version of the package
  // as a string.
  self.cordovaDependencies = {};

  // If this package has a corresponding test package (for example,
  // underscore-test), defined in the same package.js file, store its value
  // here.
  self.testName = null;

  // Test packages are dealt with differently in the linker (and not published
  // to the catalog), so we need to keep track of them.
  self.isTest = false;

  // Some packages belong to a test framework and should never be bundled into
  // production. A package with this flag should not be picked up by the bundler
  // for production builds.
  self.debugOnly = false;

  // If this is set, we will take the currently running git checkout and bundle
  // the meteor tool from it inside this package as a tool. We will include
  // built copies of all known isopackets.
  self.includeTool = false;

  // Is this a core package? Core packages don't record version files, because
  // core packages are only ever run from checkout. For the preview release,
  // core packages do not need to specify their versions at publication (since
  // there isn't likely to be any exciting version skew yet), but we will
  // specify the correct restrictions at 0.90.
  // XXX: 0.90 package versions.
  self.isCore = false;
};


_.extend(PackageSource.prototype, {
  // Make a dummy (empty) packageSource that contains nothing of interest.
  // XXX: Do we need this
  initEmpty: function (name) {
    var self = this;
    self.name = name;
  },

  // Programmatically initialize a PackageSource from scratch.
  //
  // Unlike user-facing methods of creating a package
  // (initFromPackageDir, initFromAppDir) this does not implicitly add
  // a dependency on the 'meteor' package. If you want such a
  // dependency then you must add it yourself.
  //
  // If called inside a buildmessage job, it will keep going if things
  // go wrong. Be sure to call jobHasMessages to see if it actually
  // succeeded.
  //
  // The architecture is hardcoded to be "os".
  //
  // Note that this does not set a version on the package!
  //
  // Options:
  // - sourceRoot (required if sources present)
  // - serveRoot (required if sources present)
  // - use
  // - sources (array of paths or relPath/fileOptions objects)
  // - npmDependencies
  // - cordovaDependencies
  // - npmDir
  initFromOptions: function (name, options) {
    var self = this;
    self.name = name;

    if (options.sources && ! _.isEmpty(options.sources) &&
        (! options.sourceRoot || ! options.serveRoot))
      throw new Error("When source files are given, sourceRoot and " +
                      "serveRoot must be specified");

    // sourceRoot is a relative file system path, one slash identifies a root
    // relative to some starting location
    self.sourceRoot = options.sourceRoot || files.pathSep;
    // serveRoot is actually a part of a url path, root here is a forward slash
    self.serveRoot = options.serveRoot || '/';

    var nodeModulesPath = null;
    utils.ensureOnlyExactVersions(options.npmDependencies);
    self.npmDependencies = options.npmDependencies;
    self.npmCacheDirectory = options.npmDir;

    utils.ensureOnlyExactVersions(options.cordovaDependencies);
    self.cordovaDependencies = options.cordovaDependencies;

    var sources = _.map(options.sources, function (source) {
      if (typeof source === "string")
        return {relPath: source};
      return source;
    });

    var sourceArch = new SourceArch(self, {
      kind: options.kind,
      arch: "os",
      uses: _.map(options.use, splitConstraint),
      getSourcesFunc: function () { return sources; },
      nodeModulesPath: nodeModulesPath
    });

    self.architectures.push(sourceArch);

    if (! self._checkCrossUnibuildVersionConstraints())
      throw new Error("only one unibuild, so how can consistency check fail?");
  },

  // Initialize a PackageSource from a package.js-style package directory. Uses
  // the name field provided and the name/test fields in the package.js file to
  // figre out if this is a test package (load from onTest) or a use package
  // (load from onUse).
  //
  // name: name of the package.
  // dir: location of directory on disk.
  // options:
  // - name: override the name of this package with a different name.
  // - buildingIsopackets: true if this is being scanned in the process
  //   of building isopackets
  initFromPackageDir: function (dir, options) {
    var self = this;
    buildmessage.assertInCapture();
    var isPortable = true;
    options = options || {};
    var initFromPackageDirOptions = options;

    // If we know what package we are initializing, we pass in a
    // name. Otherwise, we are intializing the base package specified by 'name:'
    // field in Package.Describe. In that case, it is clearly not a test
    // package. (Though we could be initializing a specific package without it
    // being a test, for a variety of reasons).
    if (options.name) {
      self.isTest = isTestName(options.name);
      self.name = options.name;
    }

    // Give the package a default version. We do not set
    // versionExplicitlyProvided unless the package configuration file actually
    // sets a version.
    self.version = "0.0.0";

    // To make the transition to using README.md files in Isobuild easier, we
    // initialize the documentation directory to README.md by default.
    self.metadata.documentation = "README.md";

    self.sourceRoot = dir;

    // If we are running from checkout we may be looking at a core package. If
    // we are, let's remember this for things like not recording version files.
    if (files.inCheckout()) {
      var packDir = files.pathJoin(files.getCurrentToolsDir(), 'packages');
      if (files.pathDirname(self.sourceRoot) === packDir) {
        self.isCore = true;
      }
    }
    if (! files.exists(self.sourceRoot))
      throw new Error("putative package directory " + dir + " doesn't exist?");

    var fileAndDepLoader = null;
    var npmDependencies = null;
    var cordovaDependencies = null;

    var packageJsPath = files.pathJoin(self.sourceRoot, 'package.js');
    var code = files.readFile(packageJsPath);
    var packageJsHash = watch.sha1(code);

    var releaseRecords = [];
    var hasTests = false;

    // Any package that depends on us needs to be rebuilt if our package.js file
    // changes, because a change to package.js might add or remove a plugin,
    // which could change a file from being handled by extension vs treated as
    // an asset.
    self.pluginWatchSet.addFile(packageJsPath, packageJsHash);

    // == 'Package' object visible in package.js ==

    /**
     * @global
     * @name  Package
     * @summary The Package object in package.js
     * @namespace
     * @locus package.js
     */
    var Package = {
      // Set package metadata. Options:
      // - summary: for 'meteor list' & package server
      // - version: package version string
      // There used to be a third option documented here,
      // 'environments', but it was never implemented and no package
      // ever used it.

      /**
       * @summary Provide basic package information.
       * @locus package.js
       * @memberOf Package
       * @param {Object} options
       * @param {String} options.summary A concise 1-2 sentence description of
       * the package, required for publication.
       * @param {String} options.version The (extended)
       * [semver](http://www.semver.org) version for your package. Additionally,
       * Meteor allows a wrap number: a positive integer that follows the
       * version number. If you are porting another package that uses semver
       * versioning, you may want to use the original version, postfixed with
       * `_wrapnumber`. For example, `1.2.3_1` or `2.4.5-rc1_4`. Wrap numbers
       * sort after the original numbers: `1.2.3` < `1.2.3_1` < `1.2.3_2` <
       * `1.2.4-rc.0`. If no version is specified, this field defaults to
       * `0.0.0`. If you want to publish your package to the package server, you
       * must specify a version.
       * @param {String} options.name Optional name override. By default, the
       * package name comes from the name of its directory.
       * @param {String} options.git Optional Git URL to the source repository.
       * @param {String} options.documentation Optional Filepath to
       * documentation. Set to 'README.md' by default. Set this to null to submit
       * no documentation.
       */
      describe: function (options) {
        _.each(options, function (value, key) {
          if (key === "summary" ||
              key === "git") {
            self.metadata[key] = value;
          } else if (key === "documentation") {
            self.metadata[key] = value;
            self.docsExplicitlyProvided = true;
          } else if (key === "version") {
            if (typeof(value) !== "string") {
              buildmessage.error("The package version (specified with "
                                 + "Package.describe) must be a string.");
              // Recover by pretending that version was not set.
            } else {
              var goodVersion = true;
              try {
                var parsedVersion = packageVersionParser.getValidServerVersion(
                  value);
              } catch (e) {
                if (!e.versionParserError)
                  throw e;
                buildmessage.error(
                  "The package version " + self.version + " (specified with Package.describe) "
                    + "is not a valid Meteor package version.\n"
                    + "Valid package versions are semver (see http://semver.org/), "
                    + "optionally followed by '_' and an integer greater or equal to 1.");
                goodVersion = false;
              }
              // Recover by pretending that the version was not set.
            }
            if (goodVersion && parsedVersion !== value) {
              buildmessage.error(
                "The package version (specified with Package.describe) may not "
                  + "contain a plus-separated build ID.");
              // Recover by pretending that the version was not set.
              goodVersion = false;
            }
            if (goodVersion) {
              self.version = value;
              self.versionExplicitlyProvided = true;
            }
          } else if (key === "name" && !self.isTest) {
            if (!self.name) {
              self.name = value;
            } else if (self.name !== value) {
              // Woah, so we requested a non-test package by name, and it is not
              // the name that we find inside. That's super weird.
              buildmessage.error(
                "trying to initialize a nonexistent base package " + value);
            }
          } else if (key === "debugOnly") {
            self.debugOnly = !!value;
          } else {
          // Do nothing. We might want to add some keys later, and we should err
          // on the side of backwards compatibility.
          }
        });
      },

      /**
       * @summary Define package dependencies and expose package methods.
       * @locus package.js
       * @memberOf Package
       * @param {Function} func A function that takes in the package control 'api' object, which keeps track of dependencies and exports.
       */
      onUse: function (f) {
        if (!self.isTest) {
          if (fileAndDepLoader) {
            buildmessage.error("duplicate onUse handler; a package may have " +
                               "only one", { useMyCaller: true });
            // Recover by ignoring the duplicate
            return;
          }
          fileAndDepLoader = f;
        }
      },

      /**
       * @deprecated in 0.9.0
       */
      on_use: function (f) {
        this.onUse(f);
      },

      /**
       * @summary Define dependencies and expose package methods for unit tests.
       * @locus package.js
       * @memberOf Package
       * @param {Function} func A function that takes in the package control 'api' object, which keeps track of dependencies and exports.
       */
      onTest: function (f) {
        // If we are not initializing the test package, then we are initializing
        // the normal package and have now noticed that it has tests. So, let's
        // register the test. This is a medium-length hack until we have new
        // control files.
        if (!self.isTest) {
          hasTests = true;
          return;
        }

        // We are initializing the test, so proceed as normal.
        if (self.isTest) {
          if (fileAndDepLoader) {
            buildmessage.error("duplicate onTest handler; a package may have " +
                               "only one", { useMyCaller: true });
            // Recover by ignoring the duplicate
            return;
          }
          fileAndDepLoader = f;
        }
      },

      /**
       * @deprecated in 0.9.0
       */
      on_test: function (f) {
        this.onTest(f);
      },

      // Define a plugin. A plugin extends the build process for
      // targets that use this package. For example, a Coffeescript
      // compiler would be a plugin. A plugin is its own little
      // program, with its own set of source files, used packages, and
      // npm dependencies.
      //
      // This is an experimental API and for now you should assume
      // that it will change frequently and radically (thus the
      // '_transitional_'). For maximum R&D velocity and for the good
      // of the platform, we will push changes that break your
      // packages that use this API. You've been warned.
      //
      // Options:
      // - name: a name for this plugin. required (cosmetic -- string)
      // - use: package to use for the plugin (names, as strings)
      // - sources: sources for the plugin (array of string)
      // - npmDependencies: map from npm package name to required
      //   version (string)

      /**
       * @summary Define a build plugin. A build plugin extends the build
       * process for apps and packages that use this package. For example,
       * the `coffeescript` package uses a build plugin to compile CoffeeScript
       * source files into JavaScript.
       * @param  {Object} [options]
       * @param {String} options.name A cosmetic name, must be unique in the
       * package.
       * @param {String|String[]} options.use Meteor packages that this
       * plugin uses, independent of the packages specified in
       * [api.onUse](#pack_onUse).
       * @param {String[]} options.sources The source files that make up the
       * build plugin, independent from [api.addFiles](#pack_addFiles).
       * @param {Object} options.npmDependencies An object where the keys
       * are NPM package names, and the keys are the version numbers of
       * required NPM packages, just like in [Npm.depends](#Npm-depends).
       * @memberOf Package
       * @locus package.js
       */
      registerBuildPlugin: function (options) {
        // Tests don't have plugins; plugins initialized in the control file
        // belong to the package and not to the test. (This will be less
        // confusing in the new control file format).
        if (self.isTest) {
          return;
        }

        if (! ('name' in options)) {
          buildmessage.error("build plugins require a name",
                             { useMyCaller: true });
          // recover by ignoring plugin
          return;
        }

        if (options.name in self.pluginInfo) {
          buildmessage.error("this package already has a plugin named '" +
                             options.name + "'",
                             { useMyCaller: true });
          // recover by ignoring plugin
          return;
        }

        if (options.name.match(/\.\./) || options.name.match(/[\\\/]/)) {
          buildmessage.error("bad plugin name", { useMyCaller: true });
          // recover by ignoring plugin
          return;
        }

        // XXX probably want further type checking
        self.pluginInfo[options.name] = options;
      },

      /**
       * @deprecated in 0.9.4
       */
      _transitional_registerBuildPlugin: function (options) {
        this.registerBuildPlugin(options);
      },

      includeTool: function () {
        if (!files.inCheckout()) {
          buildmessage.error("Package.includeTool() can only be used with a " +
                             "checkout of meteor");
        } else if (self.includeTool) {
          buildmessage.error("Duplicate includeTool call");
        } else {
          self.includeTool = true;
        }
      }
    };

    // == 'Npm' object visible in package.js ==

    /**
     * @namespace Npm
     * @global
     * @summary The Npm object in package.js and package source files.
     */
    var Npm = {
      /**
       * @summary Specify which [NPM](https://www.npmjs.org/) packages
       * your Meteor package depends on.
       * @param  {Object} dependencies An object where the keys are package
       * names and the values are version numbers in string form.
       * You can only depend on exact versions of NPM packages. Example:
       *
       * ```js
       * Npm.depends({moment: "2.8.3"});
       * ```
       * @locus package.js
       * @memberOf  Npm
       */
      depends: function (_npmDependencies) {
        // XXX make npmDependencies be separate between use and test, so that
        // production doesn't have to ship all of the npm modules used by test
        // code
        if (npmDependencies) {
          buildmessage.error("Npm.depends may only be called once per package",
                             { useMyCaller: true });
          // recover by ignoring the Npm.depends line
          return;
        }
        if (typeof _npmDependencies !== 'object') {
          buildmessage.error("the argument to Npm.depends should be an " +
                             "object, like this: {gcd: '0.0.0'}",
                             { useMyCaller: true });
          // recover by ignoring the Npm.depends line
          return;
        }

        // don't allow npm fuzzy versions so that there is complete
        // consistency when deploying a meteor app
        //
        // XXX use something like seal or lockdown to have *complete*
        // confidence we're running the same code?
        try {
          utils.ensureOnlyExactVersions(_npmDependencies);
        } catch (e) {
          buildmessage.error(e.message, { useMyCaller: true, downcase: true });
          // recover by ignoring the Npm.depends line
          return;
        }

        npmDependencies = _npmDependencies;
      },

      // The `Npm.strip` method makes up for packages that have missing
      // or incomplete .npmignore files by telling the bundler to strip out
      // certain unnecessary files and/or directories during `meteor build`.
      //
      // The `discards` parameter should be an object whose keys are
      // top-level package names and whose values are arrays of strings
      // (or regular expressions) that match paths in that package's
      // directory that should be stripped before installation. For
      // example:
      //
      //   Npm.strip({
      //     connect: [/*\.wmv$/],
      //     useragent: ["tests/"]
      //   });
      //
      // This means (1) "remove any files with the `.wmv` extension from
      // the 'connect' package directory" and (2) "remove the 'tests'
      // directory from the 'useragent' package directory."
      strip: function(discards) {
        self.npmDiscards.merge(discards);
      },

      require: function (name) {
        try {
          return require(name); // from the dev bundle
        } catch (e) {
          buildmessage.error(
            "can't find npm module '" + name +
              "'. In package.js, Npm.require can only find built-in modules.",
            { useMyCaller: true });
          // recover by, uh, returning undefined, which is likely to
          // have some knock-on effects
          return undefined;
        }
      }
    };

    // == 'Cordova' object visible in package.js ==

    /**
     * @namespace Cordova
     * @global
     * @summary The Cordova object in package.js.
     */
    var Cordova = {
      /**
       * @summary Specify which [Cordova / PhoneGap](http://cordova.apache.org/)
       * plugins your Meteor package depends on.
       *
       * Plugins are installed from
       * [plugins.cordova.io](http://plugins.cordova.io/), so the plugins and
       * versions specified must exist there. Alternatively, the version
       * can be replaced with a GitHub tarball URL as described in the
       * [Cordova / PhoneGap](https://github.com/meteor/meteor/wiki/Meteor-Cordova-Phonegap-integration#meteor-packages-with-cordovaphonegap-dependencies)
       * page of the Meteor wiki on GitHub.
       * @param  {Object} dependencies An object where the keys are plugin
       * names and the values are version numbers or GitHub tarball URLs
       * in string form.
       * Example:
       *
       * ```js
       * Cordova.depends({
       *   "org.apache.cordova.camera": "0.3.0"
       * });
       * ```
       *
       * Alternatively, with a GitHub URL:
       *
       * ```js
       * Cordova.depends({
       *   "org.apache.cordova.camera":
       *     "https://github.com/apache/cordova-plugin-camera/tarball/d84b875c"
       * });
       * ```
       *
       * @locus package.js
       * @memberOf  Cordova
       */
      depends: function (_cordovaDependencies) {
        // XXX make cordovaDependencies be separate between use and test, so that
        // production doesn't have to ship all of the npm modules used by test
        // code
        if (cordovaDependencies) {
          buildmessage.error("Cordova.depends may only be called once per package",
                             { useMyCaller: true });
          // recover by ignoring the Cordova.depends line
          return;
        }
        if (typeof _cordovaDependencies !== 'object') {
          buildmessage.error("the argument to Cordova.depends should be an " +
                             "object, like this: {gcd: '0.0.0'}",
                             { useMyCaller: true });
          // recover by ignoring the Cordova.depends line
          return;
        }

        // don't allow cordova fuzzy versions so that there is complete
        // consistency when deploying a meteor app
        //
        // XXX use something like seal or lockdown to have *complete*
        // confidence we're running the same code?
        try {
          utils.ensureOnlyExactVersions(_cordovaDependencies);
        } catch (e) {
          buildmessage.error(e.message, { useMyCaller: true, downcase: true });
          // recover by ignoring the Npm.depends line
          return;
        }

        cordovaDependencies = _cordovaDependencies;
      },
    };

    try {
      files.runJavaScript(code.toString('utf8'), {
        filename: 'package.js',
        symbols: { Package: Package, Npm: Npm, Cordova: Cordova }
      });
    } catch (e) {
      buildmessage.exception(e);

      // Could be a syntax error or an exception. Recover by
      // continuing as if package.js is empty. (Pressing on with
      // whatever handlers were registered before the exception turns
      // out to feel pretty disconcerting -- definitely violates the
      // principle of least surprise.) Leave the metadata if we have
      // it, though.
      fileAndDepLoader = null;
      self.pluginInfo = {};
      npmDependencies = null;
      cordovaDependencies = null;
    }

    // In the past, we did not require a Package.Describe.name field. So, it is
    // possible that we are initializing a package that doesn't use it and
    // expects us to be implicit about it.
    if (!self.name) {
      // For backwards-compatibility, we will take the package name from the
      // directory of the package. That was what we used to do: in fact, we used
      // to only do that.
      self.name = files.pathBasename(dir);
    }

    // Check to see if our name is valid.

    try {
      utils.validatePackageName(self.name);
    } catch (e) {
      if (!e.versionParserError)
        throw e;
      buildmessage.error(e.message);
      // recover by ignoring
    }

    // We want the "debug mode" to be a property of the *bundle* operation
    // (turning a set of packages, including the app, into a star), not the
    // *compile* operation (turning a package source into an isopack). This is
    // so we don't have to publish two versions of each package. But we have no
    // way to mark a file in an isopack as being the result of running a plugin
    // from a debugOnly dependency, and so there is no way to tell which files
    // to exclude in production mode from a published package. Eventually, we'll
    // add such a flag to the isopack format, but until then we'll sidestep the
    // issue by disallowing build plugins in debugOnly packages.
    if (self.debugOnly && !_.isEmpty(self.pluginInfo)) {
      buildmessage.error(
        "can't register build plugins in debugOnly packages");
      // recover by ignoring
    }

    // source files used
    var sources = {};

    // symbols exported
    var exports = {};

    // packages used and implied (keys are 'package', 'unordered', and
    // 'weak').  an "implied" package is a package that will be used by a unibuild
    // which uses us.
    var uses = {};
    var implies = {};

    _.each(compiler.ALL_ARCHES, function (arch) {
      sources[arch] = [];
      exports[arch] = [];
      uses[arch] = [];
      implies[arch] = [];
    });

    // Iterates over the list of target archs and calls f(arch) for all archs
    // that match an element of self.allarchs.
    var forAllMatchingArchs = function (archs, f) {
      _.each(archs, function (arch) {
        _.each(compiler.ALL_ARCHES, function (matchArch) {
          if (archinfo.matches(matchArch, arch)) {
            f(matchArch);
          }
        });
      });
    };

    // For this old-style, onUse/onTest/where-based package, figure
    // out its dependencies by calling its on_xxx functions and seeing
    // what it does.
    //
    // We have a simple strategy. Call its on_xxx handler with no
    // 'where', which is what happens when the package is added
    // directly to an app, and see what files it adds to the client
    // and the server. When a package is used, include it in both the client
    // and the server by default. This simple strategy doesn't capture even
    // 10% of the complexity possible with onUse, onTest, and where, but
    // probably is sufficient for virtually all packages that actually
    // exist in the field, if not every single one. #OldStylePackageSupport

    if (fileAndDepLoader) {
      var toArray = function (x) {
        if (x instanceof Array)
          return x;
        return x ? [x] : [];
      };

      var toArchArray = function (arch) {
        if (!(arch instanceof Array)) {
          arch = arch ? [arch] : compiler.ALL_ARCHES;
        }
        arch = _.uniq(arch);
        arch = _.map(arch, mapWhereToArch);
        _.each(arch, function (inputArch) {
          var isMatch = _.any(_.map(compiler.ALL_ARCHES, function (actualArch) {
            return archinfo.matches(actualArch, inputArch);
          }));
          if (! isMatch) {
            buildmessage.error(
              "Invalid 'where' argument: '" + inputArch + "'",
              // skip toArchArray in addition to the actual API function
              {useMyCaller: 2});
          }
        });
        return arch;
      };

      /**
       * @class PackageAPI
       * @instanceName api
       * @global
       * @summary The API object passed into the Packages.onUse function.
       */
      var api = {
        // Called when this package wants to make another package be
        // used. Can also take literal package objects, if you have
        // anonymous packages you want to use (eg, app packages)
        //
        // @param arch 'web', 'web.browser', 'web.cordova', 'server',
        // or an array of those.
        // The default is ['web', 'server'].
        //
        // options can include:
        //
        // - unordered: if true, don't require this package to load
        //   before us -- just require it to be loaded anytime. Also
        //   don't bring this package's imports into our
        //   namespace. If false, override a true value specified in
        //   a previous call to use for this package name. (A
        //   limitation of the current implementation is that this
        //   flag is not tracked per-environment or per-role.)  This
        //   option can be used to resolve circular dependencies in
        //   exceptional circumstances, eg, the 'meteor' package
        //   depends on 'handlebars', but all packages (including
        //   'handlebars') have an implicit dependency on
        //   'meteor'. Internal use only -- future support of this
        //   is not guaranteed. #UnorderedPackageReferences
        //
        // - weak: if true, don't require this package to load at all, but if
        //   it's going to load, load it before us.  Don't bring this
        //   package's imports into our namespace and don't allow us to use
        //   its plugins. (Has the same limitation as "unordered" that this
        //   flag is not tracked per-environment or per-role; this may
        //   change.)

        /**
         * @memberOf PackageAPI
         * @instance
         * @summary Depend on package `packagename`.
         * @locus package.js
         * @param {String|String[]} packageNames Packages being depended on.
         * Package names may be suffixed with an @version tag.
         *
         * In general, you must specify a package's version (e.g.,
         * `'accounts@1.0.0'` to use version 1.0.0 or a higher
         * compatible version (ex: 1.0.1, 1.5.0, etc.)  of the
         * `accounts` package). If you are sourcing core
         * packages from a Meteor release with `versionsFrom`, you may leave
         * off version names for core packages. You may also specify constraints,
         * such as `my:forms@=1.0.0` (this package demands `my:forms` at `1.0.0` exactly),
         * or `my:forms@1.0.0 || =2.0.1` (`my:forms` at `1.x.y`, or exactly `2.0.1`).
         * @param {String} [architecture] If you only use the package on the
         * server (or the client), you can pass in the second argument (e.g.,
         * `'server'`, `'client'`, `'web.browser'`, `'web.cordova'`) to specify
         * what architecture the package is used with.
         * @param {Object} [options]
         * @param {Boolean} options.weak Establish a weak dependency on a
         * package. If package A has a weak dependency on package B, it means
         * that including A in an app does not force B to be included too — but,
         * if B is included or by another package, then B will load before A.
         * You can use this to make packages that optionally integrate with or
         * enhance other packages if those packages are present.
         * When you weakly depend on a package you don't see its exports.
         * You can detect if the possibly-present weakly-depended-on package
         * is there by seeing if `Package.foo` exists, and get its exports
         * from the same place.
         * @param {Boolean} options.unordered It's okay to load this dependency
         * after your package. (In general, dependencies specified by `api.use`
         * are loaded before your package.) You can use this option to break
         * circular dependencies.
         */
        use: function (names, arch, options) {
          // Support `api.use(package, {weak: true})` without arch.
          if (_.isObject(arch) && !_.isArray(arch) && !options) {
            options = arch;
            arch = null;
          }
          options = options || {};

          names = toArray(names);
          arch = toArchArray(arch);

          // A normal dependency creates an ordering constraint and a "if I'm
          // used, use that" constraint. Unordered dependencies lack the
          // former; weak dependencies lack the latter. There's no point to a
          // dependency that lacks both!
          if (options.unordered && options.weak) {
            buildmessage.error(
              "A dependency may not be both unordered and weak.",
              { useMyCaller: true });
            // recover by ignoring
            return;
          }

          // using for loop rather than underscore to help with useMyCaller
          for (var i = 0; i < names.length; ++i) {
            var name = names[i];
            try {
              var parsed = utils.parsePackageConstraint(name);
            } catch (e) {
              if (!e.versionParserError)
                throw e;
              buildmessage.error(e.message, {useMyCaller: true});
              // recover by ignoring
              continue;
            }

            forAllMatchingArchs(arch, function (a) {
              uses[a].push({
                package: parsed.package,
                constraint: parsed.constraintString,
                unordered: options.unordered || false,
                weak: options.weak || false
              });
            });
          }
        },

        // Called when this package wants packages using it to also use
        // another package.  eg, for umbrella packages which want packages
        // using them to also get symbols or plugins from their components.

        /**
         * @memberOf PackageAPI
         * @summary Give users of this package access to another package (by passing  in the string `packagename`) or a collection of packages (by passing in an  array of strings [`packagename1`, `packagename2`]
         * @locus package.js
         * @instance
         * @param {String|String[]} packageSpecs Name of a package, or array of package names, with an optional @version component for each.
         */
        imply: function (names, arch) {
          // We currently disallow build plugins in debugOnly packages; but if
          // you could use imply in a debugOnly package, you could pull in the
          // build plugin from an implied package, which would have the same
          // problem as allowing build plugins directly in the package. So no
          // imply either!
          if (self.debugOnly) {
            buildmessage.error("can't use imply in debugOnly packages");
            // recover by ignoring
            return;
          }

          names = toArray(names);
          arch = toArchArray(arch);

          // using for loop rather than underscore to help with useMyCaller
          for (var i = 0; i < names.length; ++i) {
            var name = names[i];
            try {
              var parsed = utils.parsePackageConstraint(name);
            } catch (e) {
              if (!e.versionParserError)
                throw e;
              buildmessage.error(e.message, {useMyCaller: true});
              // recover by ignoring
              continue;
            }

            forAllMatchingArchs(arch, function (a) {
              // We don't allow weak or unordered implies, since the main
              // purpose of imply is to provide imports and plugins.
              implies[a].push({
                package: parsed.package,
                constraint: parsed.constraintString
              });
            });
          }
        },

        // Top-level call to add a source file to a package. It will
        // be processed according to its extension (eg, *.coffee
        // files will be compiled to JavaScript).

        /**
         * @memberOf PackageAPI
         * @instance
         * @summary Specify the source code for your package.
         * @locus package.js
         * @param {String|String[]} filename Name of the source file, or array of strings of source file names.
         * @param {String} [architecture] If you only want to export the file
         * on the server (or the client), you can pass in the second argument
         * (e.g., 'server', 'client', 'web.browser', 'web.cordova') to specify
         * what architecture the file is used with.
         */
        addFiles: function (paths, arch, fileOptions) {
          paths = toArray(paths);
          arch = toArchArray(arch);

          // Convert Dos-style paths to Unix-style paths.
          // XXX it is possible to convert an already Unix-style path by mistake
          // and break it. e.g.: 'some\folder/anotherFolder' is a valid path
          // consisting of two components. #WindowsPathApi
          paths = _.map(paths, function (p) {
            if (p.indexOf('/') !== -1) {
              // it is already a Unix-style path most likely
              return p;
            }
            return files.convertToPosixPath(p, true);
          });

          _.each(paths, function (path) {
            forAllMatchingArchs(arch, function (a) {
              var source = {relPath: path};
              if (fileOptions)
                source.fileOptions = fileOptions;
              sources[a].push(source);
            });
          });
        },

        // Use this release to resolve unclear dependencies for this package. If
        // you don't fill in dependencies for some of your implies/uses, we will
        // look at the packages listed in the release to figure that out.

        /**
         * @memberOf PackageAPI
         * @instance
         * @summary Use versions of core packages from a release. Unless provided, all packages will default to the versions released along with `meteorRelease`. This will save you from having to figure out the exact versions of the core packages you want to use. For example, if the newest release of meteor is `METEOR@0.9.0` and it includes `jquery@1.0.0`, you can write `api.versionsFrom('METEOR@0.9.0')` in your package, and when you later write `api.use('jquery')`, it will be equivalent to `api.use('jquery@1.0.0')`. You may specify an array of multiple releases, in which case the default value for constraints will be the "or" of the versions from each release: `api.versionsFrom(['METEOR@0.9.0', 'METEOR@0.9.5'])` may cause `api.use('jquery')` to be interpreted as `api.use('jquery@1.0.0 || 2.0.0')`.
         * @locus package.js
         * @param {String | String[]} meteorRelease Specification of a release: track@version. Just 'version' (e.g. `"0.9.0"`) is sufficient if using the default release track `METEOR`.
         */
        versionsFrom: function (releases) {
          // Packages in isopackets really ought to be in the core release, by
          // definition, so saying that they should use versions from another
          // release doesn't make sense. Moreover, if we're running from a
          // checkout, we build isopackets before we initialize catalog.official
          // (since we may need the ddp isopacket to refresh catalog.official),
          // so we wouldn't actually be able to interpret the release name
          // anyway.
          if (initFromPackageDirOptions.buildingIsopackets) {
            buildmessage.error(
              "packages in isopackets may not use versionsFrom");
            // recover by ignoring
            return;
          }

          releases = toArray(releases);

          // using for loop rather than underscore to help with useMyCaller
          for (var i = 0; i < releases.length; ++i) {
            var release = releases[i];

            // If you don't specify a track, use our default.
            if (release.indexOf('@') === -1) {
              release = catalog.DEFAULT_TRACK + "@" + release;
            }

            var relInf = release.split('@');
            if (relInf.length !== 2) {
              buildmessage.error("Release names in versionsFrom may not contain '@'.",
                                 { useMyCaller: true });
              return;
            }
            var releaseRecord = catalog.official.getReleaseVersion(
              relInf[0], relInf[1]);
            if (!releaseRecord) {
              buildmessage.error("Unknown release "+ release,
                                 { tags: { refreshCouldHelp: true } });
            } else {
              releaseRecords.push(releaseRecord);
            }
          }
        },

        // Export symbols from this package.
        //
        // @param symbols String (eg "Foo") or array of String
        // @param arch 'web', 'server', 'web.browser', 'web.cordova'
        // or an array of those.
        // The default is ['web', 'server'].
        // @param options 'testOnly', boolean.

        /**
         * @memberOf PackageAPI
         * @instance
         * @summary Export package-level variables in your package. The specified variables (declared without `var` in the source code) will be available to packages that use this package.
         * @locus package.js
         * @param {String} exportedObject Name of the object.
         * @param {String} [architecture] If you only want to export the object
         * on the server (or the client), you can pass in the second argument
         * (e.g., 'server', 'client', 'web.browser', 'web.cordova') to specify
         * what architecture the export is used with.
         */
        export: function (symbols, arch, options) {
          // Support `api.export("FooTest", {testOnly: true})` without
          // arch.
          if (_.isObject(arch) && !_.isArray(arch) && !options) {
            options = arch;
            arch = null;
          }
          options = options || {};

          symbols = toArray(symbols);
          arch = toArchArray(arch);

          _.each(symbols, function (symbol) {
            // XXX be unicode-friendlier
            if (!symbol.match(/^([_$a-zA-Z][_$a-zA-Z0-9]*)$/)) {
              buildmessage.error("Bad exported symbol: " + symbol,
                                 { useMyCaller: true });
              // recover by ignoring
              return;
            }
            forAllMatchingArchs(arch, function (w) {
              exports[w].push({name: symbol, testOnly: !!options.testOnly});
            });
          });
        }
      };

      // XXX COMPAT WITH 0.8.x
      api.add_files = api.addFiles;

      try {
        buildmessage.markBoundary(fileAndDepLoader)(api);
      } catch (e) {
        console.log(e.stack); // XXX should we keep this here -- or do we want broken
                              // packages to fail silently?
        buildmessage.exception(e);
        // Recover by ignoring all of the source files in the
        // packages and any remaining handlers. It violates the
        // principle of least surprise to half-run a handler
        // and then continue.
        sources = {};
        _.each(compiler.ALL_ARCHES, function (arch) {
          sources[arch] = [];
        });

        fileAndDepLoader = null;
        self.pluginInfo = {};
        npmDependencies = null;
        cordovaDependencies = null;
      }
    }

    // By the way, you can't depend on yourself.
    var doNotDepOnSelf = function (dep) {
      if (dep.package === self.name) {
        buildmessage.error("Circular dependency found: "
                           + self.name +
                           " depends on itself.\n");
      }
    };
    _.each(compiler.ALL_ARCHES, function (label) {
      _.each(uses[label], doNotDepOnSelf);
      _.each(implies[label], doNotDepOnSelf);
    });

    // If we have specified some release, then we should go through the
    // dependencies and fill in the unspecified constraints with the versions in
    // the releases (if possible).
    if (!_.isEmpty(releaseRecords)) {

      // Given a dependency object with keys package (the name of the package)
      // and constraint (the version constraint), if the constraint is null,
      // look in the packages field in the release record and fill in from
      // there.
      var setFromRel = function (dep) {
        if (dep.constraint) {
          return dep;
        }
        var newConstraint = [];
        _.each(releaseRecords, function (releaseRecord) {
          var packages = releaseRecord.packages;
          if(_.has(packages, dep.package)) {
            newConstraint.push(packages[dep.package]);
          }
        });
        if (_.isEmpty(newConstraint)) return dep;
        dep.constraint = _.reduce(newConstraint,
          function(x, y) {
            return x + " || " + y;
          });
        return dep;
      };

      // For all implies and uses, fill in the unspecified dependencies from the
      // release.
      _.each(compiler.ALL_ARCHES, function (label) {
        uses[label] = _.map(uses[label], setFromRel);
        implies[label] = _.map(implies[label], setFromRel);
      });
     };

    // Make sure that if a dependency was specified in multiple
    // unibuilds, the constraint is exactly the same.
    if (! self._checkCrossUnibuildVersionConstraints()) {
      // A build error was written. Recover by ignoring the
      // fact that we have differing constraints.
    }

    // Save information about npm dependencies. To keep metadata
    // loading inexpensive, we won't actually fetch them until build
    // time.

    // We used to put the cache directly in .npm, but in linker-land,
    // the package's own NPM dependencies go in .npm/package and build
    // plugin X's goes in .npm/plugin/X. Notably, the former is NOT an
    // ancestor of the latter, so that a build plugin does NOT see the
    // package's node_modules.  XXX maybe there should be separate NPM
    // dirs for use vs test?
    self.npmCacheDirectory =
      files.pathResolve(files.pathJoin(self.sourceRoot, '.npm', 'package'));
    self.npmDependencies = npmDependencies;

    self.cordovaDependencies = cordovaDependencies;

    // If this package was previously built with pre-linker versions,
    // it may have files directly inside `.npm` instead of nested
    // inside `.npm/package`. Clean them up if they are there. (Kind
    // of grody to do this here but it'll be fine for now, especially
    // since this is only for compatibility with very old versions of
    // Meteor.)
    var preLinkerFiles = [
      'npm-shrinkwrap.json', 'README', '.gitignore', 'node_modules'];
    _.each(preLinkerFiles, function (f) {
      files.rm_recursive(files.pathJoin(self.sourceRoot, '.npm', f));
    });

    // Create source architectures, one for the server and one for each web
    // arch.
    _.each(compiler.ALL_ARCHES, function (arch) {
      // Everything depends on the package 'meteor', which sets up
      // the basic environment) (except 'meteor' itself, and js-analyze
      // which needs to be loaded by the linker).
      // XXX add a better API for js-analyze to declare itself here
      if (self.name !== "meteor" && self.name !== "js-analyze" &&
          !process.env.NO_METEOR_PACKAGE) {
        // Don't add the dependency if one already exists. This allows the
        // package to create an unordered dependency and override the one that
        // we'd add here. This is necessary to resolve the circular dependency
        // between meteor and underscore (underscore has an unordered
        // dependency on meteor dating from when the .js extension handler was
        // in the "meteor" package).
        var alreadyDependsOnMeteor =
              !! _.find(uses[arch], function (u) {
                return u.package === "meteor";
              });
        if (! alreadyDependsOnMeteor)
          uses[arch].unshift({ package: "meteor" });
      }

      // Each unibuild has its own separate WatchSet. This is so that, eg, a test
      // unibuild's dependencies doesn't end up getting merged into the
      // pluginWatchSet of a package that uses it: only the use unibuild's
      // dependencies need to go there!
      var watchSet = new watch.WatchSet();
      watchSet.addFile(packageJsPath, packageJsHash);

      self.architectures.push(new SourceArch(self, {
        kind: "main",
        arch: arch,
        uses: uses[arch],
        implies: implies[arch],
        getSourcesFunc: function () { return sources[arch]; },
        declaredExports: exports[arch],
        watchSet: watchSet
      }));
    });

    // Serve root of the package.
    self.serveRoot = files.pathJoin('/packages/', self.name);

    // Name of the test.
    if (hasTests) {
      self.testName = genTestName(self.name);
    }
  },

  // Initialize a package from an application directory (has .meteor/packages).
  initFromAppDir: function (projectContext, ignoreFiles) {
    var self = this;
    var appDir = projectContext.projectDir;
    self.name = null;
    self.sourceRoot = appDir;
    self.serveRoot = '/';

    // special files those are excluded from app's top-level sources
    var controlFiles = ['mobile-config.js'];

    // Determine used packages. Note that these are the same for all arches,
    // because there's no way to specify otherwise in .meteor/packages.
    var uses = [];
    projectContext.projectConstraintsFile.eachConstraint(function (constraint) {
      uses.push({ package: constraint.package,
                  constraint: constraint.constraintString });
    });

    var projectWatchSet = projectContext.getProjectWatchSet();

    _.each(compiler.ALL_ARCHES, function (arch) {
      // We don't need to build a Cordova SourceArch if there are no Cordova
      // platforms.
      if (arch === 'web.cordova' &&
          _.isEmpty(projectContext.platformList.getCordovaPlatforms())) {
        return;
      }

      // XXX what about /web.browser/* etc, these directories could also
      // be for specific client targets.

      // Create unibuild
      var sourceArch = new SourceArch(self, {
        kind: 'app',
        arch: arch,
        uses: uses
      });
      self.architectures.push(sourceArch);

      // sourceArch's WatchSet should include all the project metadata files
      // read by the ProjectContext.
      sourceArch.watchSet.merge(projectWatchSet);

      // Determine source files
      sourceArch.getSourcesFunc = function (extensions, watchSet) {
        var sourceInclude = _.map(
          extensions,
          function (isTemplate, ext) {
            return new RegExp('\\.' + utils.quotemeta(ext) + '$');
          }
        );
        var sourceExclude = [/^\./].concat(ignoreFiles);

        // Wrapper around watch.readAndWatchDirectory which takes in and returns
        // sourceRoot-relative directories.
        var readAndWatchDirectory = function (relDir, filters) {
          filters = filters || {};
          var absPath = files.pathJoin(self.sourceRoot, relDir);
          var contents = watch.readAndWatchDirectory(watchSet, {
            absPath: absPath,
            include: filters.include,
            exclude: filters.exclude
          });
          return _.map(contents, function (x) {
            return files.pathJoin(relDir, x);
          });
        };

        // Read top-level source files.
        var sources = readAndWatchDirectory('', {
          include: sourceInclude,
          exclude: sourceExclude
        });

        // don't include watched but not included control files
        sources = _.difference(sources, controlFiles);

        var otherUnibuildRegExp =
              (arch === "os" ? /^client\/$/ : /^server\/$/);

        // The paths that we've called checkForInfiniteRecursion on.
        var seenPaths = {};
        // Used internally by files.realpath as an optimization.
        var realpathCache = {};
        var checkForInfiniteRecursion = function (relDir) {
          var absPath = files.pathJoin(self.sourceRoot, relDir);
          try {
            var realpath = files.realpath(absPath, realpathCache);
          } catch (e) {
            if (!e || e.code !== 'ELOOP')
              throw e;
            // else leave realpath undefined
          }
          if (realpath === undefined || _.has(seenPaths, realpath)) {
            buildmessage.error("Symlink cycle detected at " + relDir);
            // recover by returning no files
            return true;
          }
          seenPaths[realpath] = true;
          return false;
        };

        // Read top-level subdirectories. Ignore subdirectories that have
        // special handling.
        var sourceDirectories = readAndWatchDirectory('', {
          include: [/\/$/],
          exclude: [/^packages\/$/, /^tests\/$/,
                    // XXX We no longer actually have special handling
                    //     for the programs subdirectory, but let's not
                    //     suddenly start treating it as part of the main
                    //     app program.
                    /^programs\/$/,
                    /^public\/$/, /^private\/$/,
                    /^cordova-build-override\/$/,
                    otherUnibuildRegExp].concat(sourceExclude)
        });
        checkForInfiniteRecursion('');

        while (!_.isEmpty(sourceDirectories)) {
          var dir = sourceDirectories.shift();

          // remove trailing slash
          dir = dir.substr(0, dir.length - 1);

          if (checkForInfiniteRecursion(dir))
            return [];  // pretend we found no files

          // Find source files in this directory.
          Array.prototype.push.apply(sources, readAndWatchDirectory(dir, {
            include: sourceInclude,
            exclude: sourceExclude
          }));

          // Find sub-sourceDirectories. Note that we DON'T need to ignore the
          // directory names that are only special at the top level.
          Array.prototype.push.apply(sourceDirectories, readAndWatchDirectory(dir, {
            include: [/\/$/],
            exclude: [/^tests\/$/, otherUnibuildRegExp].concat(sourceExclude)
          }));
        }

        // We've found all the source files. Sort them!
        var templateExtensions = [];
        _.each(extensions, function (isTemplate, ext) {
          isTemplate && templateExtensions.push(ext);
        });
        sources.sort(loadOrderSort(templateExtensions));

        // Convert into relPath/fileOptions objects.
        sources = _.map(sources, function (relPath) {
          var sourceObj = {relPath: relPath};

          // Special case: on the client, JavaScript files in a
          // `client/compatibility` directory don't get wrapped in a closure.
          if (archinfo.matches(arch, "web") && relPath.match(/\.js$/)) {
            var clientCompatSubstr =
              files.pathSep + 'client' +
              files.pathSep + 'compatibility' + files.pathSep;

            if ((files.pathSep + relPath).indexOf(clientCompatSubstr) !== -1)
              sourceObj.fileOptions = {bare: true};
          }
          return sourceObj;
        });

        // Now look for assets for this unibuild.
        var assetDir = archinfo.matches(arch, "web") ? "public" : "private";
        var assetDirs = readAndWatchDirectory('', {
          include: [new RegExp('^' + assetDir + '/$')]
        });

        if (!_.isEmpty(assetDirs)) {
          if (!_.isEqual(assetDirs, [assetDir + '/']))
            throw new Error("Surprising assetDirs: " + JSON.stringify(assetDirs));

          while (!_.isEmpty(assetDirs)) {
            dir = assetDirs.shift();
            // remove trailing slash
            dir = dir.substr(0, dir.length - 1);

            if (checkForInfiniteRecursion(dir))
              return [];  // pretend we found no files

            // Find asset files in this directory.
            var assetsAndSubdirs = readAndWatchDirectory(dir, {
              include: [/.?/],
              // we DO look under dot directories here
              exclude: ignoreFiles
            });

            _.each(assetsAndSubdirs, function (item) {
              if (item[item.length - 1] === '/') {
                // Recurse on this directory.
                assetDirs.push(item);
              } else {
                // This file is an asset.
                sources.push({
                  relPath: item,
                  fileOptions: {
                    isAsset: true
                  }
                });
              }
            });
          }
        }

        return sources;
      };
    });

    if (! self._checkCrossUnibuildVersionConstraints()) {
      // should never happen since we created the unibuilds from
      // .meteor/packages, which doesn't have a way to express
      // different constraints for different unibuilds
      throw new Error("conflicting constraints in a package?");
    }
  },

  // True if the package defines any plugins.
  containsPlugins: function () {
    var self = this;
    return ! _.isEmpty(self.pluginInfo);
  },

  // Return dependency metadata for all unibuilds, in the format needed
  // by the package catalog.
  //
  // Options:
  // - logError: if true, if something goes wrong, log a buildmessage
  //   and return null rather than throwing an exception.
  // - skipWeak: omit weak dependencies
  // - skipUnordered: omit unordered dependencies
  getDependencyMetadata: function (options) {
    var self = this;
    options = options || {};
    var ret = self._computeDependencyMetadata(options);
    if (! ret) {
      if (options.logError)
        return null;
      else
        throw new Error("inconsistent dependency constraint across unibuilds?");
    }
    return ret;
  },

  // Returns a list of package names which should be loaded before building this
  // package. This is all the packages that we directly depend on in a unibuild
  // or from a plugin.
  //
  // (It's possible that we could do something slightly fancier where we only
  // need to load those dependencies (including implied dependencies) which we
  // know contain plugins first, plus the transitive closure of all the packages
  // we depend on which contain a plugin. This seems good enough, though.)
  getPackagesToLoadFirst: function (packageMap) {
    var self = this;
    var packages = {};
    var processUse = function (use) {
      // We don't have to build weak or unordered deps first (eg they can't
      // contribute to a plugin).
      if (use.weak || use.unordered)
        return;
      var packageInfo = packageMap.getInfo(use.package);

      if (! packageInfo)
        throw Error("Depending on unknown package " + use.package);
      packages[use.package] = true;
    };

    _.each(self.architectures, function (arch) {
      // We need to iterate over both uses and implies, since implied packages
      // also constitute dependencies. We don't have to include the dependencies
      // of implied packages directly here, since their own
      // getPackagesToLoadFirst will include those.
      _.each(arch.uses, processUse);
      _.each(arch.implies, processUse);
    });

    _.each(self.pluginInfo, function (info) {
      // info.use is currently just an array of strings, and there's
      // no way to specify weak/unordered. Much like an app.
      _.each(info.use, function (spec) {
        var parsedSpec = splitConstraint(spec);
        packages[parsedSpec.package] = true;
      });
    });
    return _.keys(packages);
  },

  // Returns an array of objects, representing this package's public
  // exports. Each object has the following keys:
  //  - name: export name (ex: "Accounts")
  //  - arch: an array of strings representing architectures for which this
  //    export is declared.
  //
  // This ignores testOnly exports.
  getExports: function () {
    var self = this;
    var ret = {};
    // Go over all of the architectures, and aggregate the exports together.
    _.each(self.architectures, function (arch) {
      _.each(arch.declaredExports, function (exp) {
        // Skip testOnly exports -- the flag is intended for use in testing
        // only, so it is not of any interest outside this package.
        if (exp.testOnly) {
          return;
        }
        // Add the export to the export map.
        if (! _.has(ret, exp.name)) {
          ret[exp.name] = [arch.arch];
        } else {
          ret[exp.name].push(arch.arch);
        }
     });
    });
    return _.map(ret, function (arches, name) {
      return { name: name, architectures: arches };
    });
   },

  // Processes the documentation provided in Package.describe. Returns an object
  // with the following keys:
  //   - path: full filepath to the Readme file
  //   - excerpt: the subsection between the first and second heading of the
  //     Readme, to be used as a longform package description.
  //   - hash: hash of the full text of this Readme, or "" if the Readme is
  //     blank.
  //
  // Returns null if the documentation is marked as null, or throws a
  // buildmessage error if the documentation could not be read.
  //
  // This function reads and performs string operations on a (potentially) long
  // file. We do not call it unless we actually need this information.
  processReadme: function () {
    var self = this;
    buildmessage.assertInJob();
    if (! self.metadata.documentation) {
      return null;
    }

    // To ensure atomicity, we want to copy the README to a temporary file.
    var ret = {};
    ret.path =
      files.pathJoin(self.sourceRoot, self.metadata.documentation);
    // Read in the text of the Readme.
    try {
      var fullReadme = files.readFile(ret.path);
    } catch (err) {
      var errorMessage = "";
      if (err.code === "ENOENT") {
        // This is the most likely and common case, especially when we are
        // inferring the docs as a default value.
        errorMessage = "Documentation not found: " + self.metadata.documentation;
      } else {
        // This is weird, and we don't usually protect the user from errors like
        // this, but maybe we should.
        errorMessage =
          "Documentation couldn't be read: " + self.metadata.documentation + " ";
        errorMessage += "(Error: " + err.message + ")";
      }

      // The user might not understand that we are automatically inferring
      // README.md as the docs! If they want to avoid pushing anything, explain
      // how to do that.
      if (! self.docsExplicitlyProvided) {
        errorMessage += "\n" +
          "If you don't want to publish any documentation, " +
          "please set 'documentation: null' in Package.describe";
      }
      buildmessage.error(errorMessage);
      // Recover by returning null
      return null;
    }

    var text = fullReadme.toString();
    return {
      contents: text,
      hash: utils.sha256(text),
      excerpt: getExcerptFromReadme(text)
    };
  },

  // If dependencies aren't consistent across unibuilds, return false and
  // also log a buildmessage error if inside a buildmessage job. Else
  // return true.
  // XXX: Check that this is used when refactoring is done.
  _checkCrossUnibuildVersionConstraints: function () {
    var self = this;
    return !! self._computeDependencyMetadata({ logError: true });
  },

  // Compute the return value for getDependencyMetadata, or return
  // null if there is a dependency that doesn't have the same
  // constraint across all unibuilds (and, if logError is true, log a
  // buildmessage error).
  //
  // For options, see getDependencyMetadata.
  _computeDependencyMetadata: function (options) {
    var self = this;
    options = options || {};

    var dependencies = {};
    var allConstraints = {}; // for error reporting. package name to array
    var failed = false;

    _.each(self.architectures, function (arch) {
      // We need to iterate over both uses and implies, since implied packages
      // also constitute dependencies.
      var processUse = function (implied, use) {
        // We can't really have a weak implies (what does that even mean?) but
        // we check for that elsewhere.
        if ((use.weak && options.skipWeak) ||
            (use.unordered && options.skipUnordered))
          return;

        if (!_.has(dependencies, use.package)) {
          dependencies[use.package] = {
            constraint: null,
            references: []
          };
          allConstraints[use.package] = [];
        }
        var d = dependencies[use.package];

        if (use.constraint) {
          allConstraints[use.package].push(use.constraint);

          if (d.constraint === null) {
            d.constraint = use.constraint;
          } else if (d.constraint !== use.constraint) {
            failed = true;
          }
        }

        var reference = {
          arch: archinfo.withoutSpecificOs(arch.arch)
        };
        if (use.weak) {
          reference.weak = true;
        }
        if (use.unordered) {
          reference.unordered = true;
        }
        if (implied) {
          reference.implied = true;
        }
        d.references.push(reference);
      };
      _.each(arch.uses, _.partial(processUse, false));
      _.each(arch.implies, _.partial(processUse, true));
    });

    _.each(self.pluginInfo, function (info) {
      _.each(info.use, function (spec) {
        var parsedSpec = splitConstraint(spec);
        if (!_.has(dependencies, parsedSpec.package)) {
          dependencies[parsedSpec.package] = {
            constraint: null,
            references: []
          };
          allConstraints[parsedSpec.package] = [];
        }
        var d = dependencies[parsedSpec.package];

        if (parsedSpec.constraint) {
          allConstraints[parsedSpec.package].push(parsedSpec.constraint);
          if (d.constraint === null) {
            d.constraint = parsedSpec.constraint;
          } else if (d.constraint !== parsedSpec.constraint) {
            failed = true;
          }
        }
        d.references.push({arch: 'plugin'});
      });
    });

    if (failed && options.logError) {
      _.each(allConstraints, function (constraints, name) {
        constraints = _.uniq(constraints);
        if (constraints.length > 1) {
          buildmessage.error(
            "The version constraint for a dependency must be the same " +
              "at every place it is mentioned in a package. " +
              "'" + name + "' is constrained both as "  +
              constraints.join(' and ') + ". Change them to match.");
          // recover by returning false (the caller had better detect
          // this and use its own recovery logic)
        }
      });
    }

    return failed ? null : dependencies;
  }
});

module.exports = PackageSource;
