var path = require("path");
var fs = require("fs");
var os = require("os");
var Future = require("fibers/future");
var _ = require("underscore");
var files = require('./files.js');
var utils = require('./utils.js');
var updater = require('./updater.js');
var httpHelpers = require('./http-helpers.js');
var fiberHelpers = require('./fiber-helpers.js');
var release = require('./release.js');
var archinfo = require('./archinfo.js');
var catalog = require('./catalog.js');
var Unipackage = require('./unipackage.js').Unipackage;
var config = require('./config.js');
var buildmessage = require('./buildmessage.js');

exports.Tropohouse = function (root, catalog) {
  var self = this;
  self.root = root;
  self.catalog = catalog;
};

// Return the directory containing our loaded collection of tools, releases and
// packages. If we're running an installed version, found at $HOME/.meteor, if
// we are running form a checkout, probably at $CHECKOUT_DIR/.meteor.
var defaultWarehouseDir = function () {
  // a hook for tests, or i guess for users.
  if (process.env.METEOR_WAREHOUSE_DIR)
    return process.env.METEOR_WAREHOUSE_DIR;

  var warehouseBase = files.inCheckout()
     ? files.getCurrentToolsDir() : process.env.HOME;
  // XXX This will be `.meteor` soon, once we've written the code to make the
  // tropohouse and warehouse live together in harmony (eg, allowing tropohouse
  // tools to springboard to warehouse tools).
  return path.join(warehouseBase, ".meteor");
};

// The default tropohouse is on disk at defaultWarehouseDir() and knows not to
// download local packages; you can make your own Tropohouse to override these
// things.
exports.default = new exports.Tropohouse(
  defaultWarehouseDir(), catalog.complete);

_.extend(exports.Tropohouse.prototype, {
  // Returns the load path where one can expect to find the package, at a given
  // version, if we have already downloaded from the package server. Does not
  // check for contents.
  //
  // Returns null if the package name is lexographically invalid.
  packagePath: function (packageName, version, relative) {
    var self = this;
    if (! utils.validPackageName(packageName)) {
      return null;
    }

    var relativePath = path.join(config.getPackagesDirectoryName(),
                                 packageName, version);
    return relative ? relativePath : path.join(self.root, relativePath);
  },

  // Pretty extreme! We call this when we learn that something has changed on
  // the server in a way that our sync protocol doesn't understand well.
  wipeAllPackages: function () {
    var self = this;

    var packagesDirectoryName = config.getPackagesDirectoryName();

    var packageRootDir = path.join(self.root, packagesDirectoryName);
    try {
      var packages = fs.readdirSync(packageRootDir);
    } catch (e) {
      // No packages at all? We're done.
      if (e.code === 'ENOENT')
        return;
      throw e;
    }

    // We want to be careful not to break the 'meteor' symlink inside the
    // tropohouse. Hopefully nobody deleted that package!
    var latestToolPackage = null;
    var latestToolVersion = null;
    var currentToolPackage = null;
    var currentToolVersion = null;
    if (release.current.isProperRelease()) {
      currentToolPackage = release.current.getToolsPackage();
      currentToolVersion = release.current.getToolsVersion();
      var latestMeteorSymlink = self.latestMeteorSymlink();
      if (utils.startsWith(latestMeteorSymlink,
                           packagesDirectoryName + path.sep)) {
        var rest = latestMeteorSymlink.substr(packagesDirectoryName.length + path.sep.length);
        var pieces = rest.split(path.sep);
        latestToolPackage = pieces[0];
        latestToolVersion = pieces[1];
      }
    }

    _.each(packages, function (package) {
      var packageDir = path.join(packageRootDir, package);
      _.each(fs.readdirSync(packageDir), function (version) {
        // Is this a pre-0.9.0 "warehouse" version with a hash name?
        if (/^[a-f0-9]{3,}$/.test(version))
          return;

        // Skip the currently-latest tool (ie, don't break top-level meteor
        // symlink). This includes both the symlink with its name and the thing
        // it points to.
        if (package === latestToolPackage &&
            (version === latestToolVersion ||
             utils.startsWith(version, '.' + latestToolVersion + '.'))) {
          return;
        }

        // Skip the currently-executing tool (ie, don't break the current
        // operation).
        if (package === currentToolPackage &&
            (version === currentToolVersion ||
             utils.startsWith(version, '.' + currentToolVersion + '.'))) {
          return;
        }

        files.rm_recursive(path.join(packageDir, version));
      });
    });
  },

  // Contacts the package server, downloads and extracts a tarball for a given
  // buildRecord into a temporary directory, whose path is returned.
  //
  // XXX: Error handling.
  downloadBuildToTempDir: function (versionInfo, buildRecord) {
    var self = this;
    var targetDirectory = files.mkdtemp();
    var packageTarball = httpHelpers.getUrl({
      url: buildRecord.build.url,
      encoding: null
    });
    files.extractTarGz(packageTarball, targetDirectory);
    return targetDirectory;
  },

  // Given versionInfo for a package version and required architectures, checks
  // to make sure that we have the package at the requested arch. If we do not
  // have the package, contact the server and attempt to download and extract
  // the right build.
  //
  // XXX more precise error handling in offline case. maybe throw instead like
  // warehouse does.  actually, generally deal with error handling.
  maybeDownloadPackageForArchitectures: function (options) {
    var self = this;
    buildmessage.assertInCapture();
    if (!options.packageName)
      throw Error("Missing required argument: packageName");
    if (!options.version)
      throw Error("Missing required argument: version");
    if (!options.architectures)
      throw Error("Missing required argument: architectures");

    var packageName = options.packageName;
    var version = options.version;

    // If this package isn't coming from the package server (loaded from a
    // checkout, or from an app package directory), don't try to download it (we
    // already have it)
    if (self.catalog.isLocalPackage(packageName))
      return;

    // Figure out what arches (if any) we have loaded for this package version
    // already.
    var packageLinkFile = self.packagePath(packageName, version);
    var downloadedArches = [];
    var packageLinkTarget = null;
    try {
      packageLinkTarget = fs.readlinkSync(packageLinkFile);
    } catch (e) {
      // Complain about anything other than "we don't have it at all". This
      // includes "not a symlink": The main reason this would not be a symlink
      // is if it's a directory containing a pre-0.9.0 package (ie, this is a
      // warehouse package not a tropohouse package). But the versions should
      // not overlap: warehouse versions are truncated SHAs whereas tropohouse
      // versions should be semver.
      if (e.code !== 'ENOENT')
        throw e;
    }
    if (packageLinkTarget) {
      // The symlink will be of the form '.VERSION.RANDOMTOKEN++web.browser+os',
      // so this strips off the part before the '++'.
      // XXX maybe we should just read the unipackage.json instead of
      //     depending on the symlink?
      var archPart = packageLinkTarget.split('++')[1];
      if (!archPart)
        throw Error("unexpected symlink target for " + packageName + "@" +
                    version + ": " + packageLinkTarget);
      downloadedArches = archPart.split('+');
    }

    var archesToDownload = _.filter(options.architectures, function (requiredArch) {
      return !archinfo.mostSpecificMatch(requiredArch, downloadedArches);
    });

    // Have everything we need? Great.
    if (!archesToDownload.length) {
      return;
    }

    var buildsToDownload = self.catalog.getBuildsForArches(
      packageName, version, archesToDownload);
    if (! buildsToDownload) {
      throw new Error(
        "No compatible build found for " + packageName + "@" + version);
    }

    // XXX replace with a real progress bar in downloadMissingPackages
    if (!options.silent) {
      process.stderr.write(
        "  downloading " + packageName + " at version " + version + " ... ");
    }

    var buildTempDirs = [];
    // If there's already a package in the tropohouse, start with it.
    if (packageLinkTarget) {
      buildTempDirs.push(path.resolve(path.dirname(packageLinkFile),
                                      packageLinkTarget));
    }
    // XXX how does concurrency work here?  we could just get errors if we try
    // to rename over the other thing?  but that's the same as in warehouse?
    _.each(buildsToDownload, function (build) {
      buildTempDirs.push(self.downloadBuildToTempDir(
        {packageName: packageName, version: version}, build));
    });

    // We need to turn our builds into a single unipackage.
    var unipackage = new Unipackage;
    _.each(buildTempDirs, function (buildTempDir, i) {
      unipackage._loadUnibuildsFromPath(
        packageName,
        buildTempDir,
        {firstUnipackage: i === 0});
    });
    // Note: wipeAllPackages depends on this filename structure, as does the
    // part above which readlinks.
    var newPackageLinkTarget = '.' + version + '.'
          + utils.randomToken() + '++' + unipackage.buildArchitectures();
    var combinedDirectory = self.packagePath(packageName, newPackageLinkTarget);
    unipackage.saveToPath(combinedDirectory, {
      // We got this from the server, so we can't rebuild it.
      elideBuildInfo: true
    });
    files.symlinkOverSync(newPackageLinkTarget, packageLinkFile);

    // Clean up old version.
    if (packageLinkTarget) {
      files.rm_recursive(self.packagePath(packageName, packageLinkTarget));
    }

    if (!options.silent) {
      process.stderr.write(" done\n");
    }

    return;
  },


  // Go through a list of packages and makes sure we have enough builds of the
  // package downloaded such that we can load a browser unibuild and a unibuild
  // that will run on this system (or the requested architecture). Return the
  // object with mapping packageName to version for the packages that we have
  // successfully downloaded.
  downloadMissingPackages: function (versionMap, options) {
    var self = this;
    buildmessage.assertInCapture();
    options = options || {};
    var serverArch = options.serverArch || archinfo.host();
    var downloadedPackages = {};
    _.each(versionMap, function (version, name) {
      try {
        self.maybeDownloadPackageForArchitectures({
          packageName: name,
          version: version,
          architectures: [serverArch]
        });
        downloadedPackages[name] = version;
      } catch (err) {
        // We have failed to download the right things and put them on disk!
        // This should not happen, and we aren't sure why it happened.
        // XXX plenty of reasons why this might happen!  eg, no network.
        //     better error handling here!
        console.log(err);
      }
    });
    return downloadedPackages;
  },

  latestMeteorSymlink: function () {
    var self = this;
    var linkPath = path.join(self.root, 'meteor');
    return fs.readlinkSync(linkPath);
  },

  replaceLatestMeteorSymlink: function (linkText) {
    var self = this;
    var linkPath = path.join(self.root, 'meteor');
    files.symlinkOverSync(linkText, linkPath);
  }
});
